// The order state machine. Every step that moves funds runs under `state.busy`, so the
// router's main account is only ever touched by one order at a time and balance deltas
// around the ICPSwap call can be attributed to that order.
import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Account "../../common/Account";
import Guard "Guard";
import Ext "../../common/Ext";
import Types "../types";

module {

  type Order = Types.Order;
  type Status = Types.Status;

  // Fixed probe used to read the pool's marginal price (0.01 ICP).
  let probeE8s : Nat = 1_000_000;
  let bpsDenom : Nat = 10_000;

  // NAKSwap fee: accrued fees are swept to the fee wallet once they reach this (0.05 ICP),
  // so the 0.0001 ICP ledger fee stays small next to what is sent.
  public let feeAutoSweepE8s : Nat = 5_000_000;
  public let feeMaxBps : Nat = 500;

  public func routerFee(fees : Types.FeeState, bal : Nat) : Nat { bal * fees.bps / bpsDenom };

  public func minus(a : Nat, b : Nat) : Nat {
    if (a <= b) { 0 } else { (a - b : Int).toNat() };
  };

  public func isActive(status : Status) : Bool {
    switch status {
      // #swapping counts as active so an order interrupted mid-swap (trap, upgrade) is seen
      // by the worker and moved to #needsReview instead of disappearing from view.
      case (#awaitingDeposit or #swapping _ or #payoutPending _ or #refundPending _) { true };
      case _ { false };
    };
  };

  func nowNat64() : Nat64 { Int.abs(Time.now()).toNat64() };

  func failingTooLong(since : Nat64) : Bool {
    nowNat64() > since + 3_600_000_000_000;
  };

  public func setStatus(order : Order, active : Set.Set<Nat>, status : Status) {
    order.status := status;
    if (isActive(status)) { active.add(order.id) } else { active.remove(order.id) };
  };

  // No deposit within the order's window. The order is kept (not deleted) and watched for a
  // late deposit for a few days; see watchLate.
  public func expire(rt : Types.Runtime, order : Order, active : Set.Set<Nat>) {
    setStatus(order, active, #expired);
    watch(rt, order.id);
  };

  // Bounded: past `maxLateWatch` entries new expiries aren't watched (an admin can still
  // recoverDeposit); only reachable by a flood of abandoned orders.
  public func watch(rt : Types.Runtime, id : Nat) {
    if (rt.lateWatch.size() < Guard.maxLateWatch or rt.lateWatch.containsKey(id)) {
      rt.lateWatch.add(id, Time.now() + Guard.lateCheckNanos);
    };
  };

  // ---------------------------------------------------------------------------------
  // Late deposits. A few expired orders per tick have their deposit account checked; one
  // that now holds ICP goes back to #awaitingDeposit and is swapped (or refunded, e.g. if
  // too small or the price moved past its minimum) by the normal worker. Dust that wouldn't
  // cover a refund is ignored. Nothing here moves funds.
  // ---------------------------------------------------------------------------------
  public func watchLate(
    state : Types.RouterState,
    rt : Types.Runtime,
    orders : Map.Map<Nat, Order>,
    active : Set.Set<Nat>,
    self : Principal,
    force : Bool, // manual check: don't wait for each entry's 10-minute spacing
  ) : async* () {
    if (Cycles.balance() < Guard.lowCycles) { return };
    let cfg = state.config;
    let now = Time.now();
    // Drop finished entries, then check the most overdue ones first: a checked entry goes to
    // the back of the queue, so every watched order gets its turn however many there are.
    let due = List.empty<(Nat, Int)>();
    label scan for ((id, at) in rt.lateWatch.entries().toArray().values()) {
      let o = switch (orders.get(id)) {
        case (?o) { o };
        case null { rt.lateWatch.remove(id); continue scan };
      };
      // Watched for 3 days after the order's own window closed.
      if (now > o.createdAt + cfg.orderTtlSeconds * 1_000_000_000 + Guard.lateWatchNanos) {
        rt.lateWatch.remove(id);
        continue scan;
      };
      switch (o.status) {
        case (#expired) {};
        // Finished orders: ICP sent after the swap or refund (a second payment, the real one
        // after a too-small test). Not while any of the order's fee is still accounted for in
        // its deposit account (it isn't the user's).
        case (#completed _ or #refunded _) {
          if (rt.subFees.containsKey(id) or rt.payFromSub.contains(id) or rt.jobFees.containsKey(id)) { continue scan };
        };
        case _ { rt.lateWatch.remove(id); continue scan }; // reopened, being processed, or in review
      };
      if (rt.inFlight.contains(id)) { continue scan };
      // A manual check takes entries early too (still most overdue first).
      if (force or at <= now) { due.add((id, at)) };
    };
    let picked = due.toArray().sort(func(a : (Nat, Int), b : (Nat, Int)) : Order.Order = Int.compare(a.1, b.1));
    for ((id, at) in picked.sliceToArray(0, Nat.min(picked.size(), Guard.lateChecksPerTick)).values()) {
      label one {
      let o = switch (orders.get(id)) { case (?o) { o }; case null { break one } };
      // Next check strictly after this one, so a checked entry always moves behind those
      // still waiting (even when many expired in the same tick and share a timestamp).
      // Spaced out as the order ages: late payments almost always arrive within hours.
      let next = Int.max(Time.now(), at) + lateInterval(o, cfg, Time.now());
      if (rt.inFlight.contains(id)) { break one };
      rt.inFlight.add(id);
      try {
        let bal = await icp(cfg).icrc1_balance_of({ owner = self; subaccount = ?o.subaccount });
        // Re-check after the await: an admin may have acted on it meanwhile.
        switch (o.status) {
          case (#expired or #completed _ or #refunded _) {
            if (bal >= Nat.max(Guard.minDepositE8s, 2 * cfg.icpFee + 1)) {
              rt.lateWatch.remove(id);
              switch (o.status) { case (#completed _ or #refunded _) { rt.revived.add(id) }; case _ {} };
              setStatus(o, active, #awaitingDeposit); // swapped or refunded by the worker
            } else {
              rt.lateWatch.add(id, next);
            };
          };
          case _ { rt.lateWatch.remove(id) };
        };
      } catch (_) {
        rt.lateWatch.add(id, next);
      } finally { rt.inFlight.remove(id) };
      };
    };
  };

  // Every 10 minutes for the first 6 hours after the order's window closed, then hourly
  // until 24 hours, then every 6 hours until the watch ends (3 days): about 65 ledger
  // queries per watched order instead of about 440.
  public func lateInterval(o : Order, cfg : Types.Config, now : Int) : Int {
    let age = now - (o.createdAt + cfg.orderTtlSeconds * 1_000_000_000);
    if (age < Guard.lateFastNanos) { Guard.lateCheckNanos } else if (age < Guard.lateHourlyUntilNanos) {
      Guard.lateHourlyNanos;
    } else { Guard.lateSlowNanos };
  };

  func icp(cfg : Types.Config) : Ext.Ledger = actor (cfg.icpLedger.toText());
  func nak(cfg : Types.Config) : Ext.Ledger = actor (cfg.nakLedger.toText());
  func pool(cfg : Types.Config) : Ext.SwapPool = actor (cfg.pool.toText());

  // ---------------------------------------------------------------------------------
  // Price reference. The impact and slippage checks read the pool at the moment of the
  // swap, so a price pushed just before it would pass them. The worker keeps a slow moving
  // average of the pool's marginal price (sampled each tick while orders are open); a swap
  // whose live price is more than `Guard.priceGuardBps` worse than that average waits for a
  // later tick. Someone pushing the price would have to hold it for minutes, against
  // arbitrage; a genuine move is followed by the average within a few ticks.
  // ---------------------------------------------------------------------------------
  public func priceSane(ref : Types.PriceRef, liveProbe : Nat, now : Int) : Bool {
    // No reference at all (fresh install): nothing to compare with. A reference that went
    // stale (no sample for 10 minutes): wait for the next tick's sample.
    if (ref.probe == 0) { return true };
    if (now - ref.at > Guard.priceRefMaxAgeNanos) { return false };
    liveProbe * bpsDenom >= ref.probe * minus(bpsDenom, Guard.priceGuardBps);
  };

  public func updatePriceRef(ref : Types.PriceRef, liveProbe : Nat, now : Int) {
    if (liveProbe == 0) { return };
    ref.probe := if (ref.probe == 0 or now - ref.at > Guard.priceRefMaxAgeNanos) { liveProbe } else {
      (ref.probe * 4 + liveProbe) / 5;
    };
    ref.at := now;
  };

  public func samplePrice(state : Types.RouterState, rt : Types.Runtime) : async* () {
    let cfg = state.config;
    try {
      switch (await pool(cfg).quote({ amountIn = probeE8s.toText(); zeroForOne = cfg.icpIsToken0; amountOutMinimum = "0" })) {
        case (#ok m) { updatePriceRef(rt.priceRef, m, Time.now()) };
        case (#err _) {};
      };
    } catch (_) {};
  };

  // Price impact of swapping `amountIn` vs the pool's marginal price, in basis points.
  public func impactBps(amountIn : Nat, quoteOut : Nat, probeOut : Nat) : Nat {
    if (probeOut == 0 or amountIn == 0) { return bpsDenom };
    // effective = quoteOut/amountIn ; marginal = probeOut/probe
    let effectiveScaled = quoteOut * probeE8s * bpsDenom / (amountIn * probeOut);
    minus(bpsDenom, effectiveScaled);
  };

  // ---------------------------------------------------------------------------------
  // Entry point: advance one order by at most one step. Caller must hold no lock.
  // ---------------------------------------------------------------------------------
  public func step(
    state : Types.RouterState,
    fees : Types.FeeState,
    rt : Types.Runtime,
    orders : Map.Map<Nat, Order>,
    active : Set.Set<Nat>,
    self : Principal,
    id : Nat,
  ) : async* Types.PokeResult {
    let order = switch (orders.get(id)) {
      case (?o) { o };
      case null { return #notFound };
    };
    // One step per order at a time. (The global `busy` lock now only guards the router's
    // main account: legacy swaps without helpers, payouts/refunds from main, fee sweeps.)
    if (rt.inFlight.contains(id)) { return #busy };
    // Restored when the step can't proceed for lack of a free helper / the lock, so the
    // worker retries on its next tick instead of a minute later.
    let prevChecked = order.lastCheckedAt;
    order.lastCheckedAt := Time.now();

    let cycles = Cycles.balance();
    switch (order.status) {
      case (#awaitingDeposit) {
        // Low on cycles: don't start swaps. ICP that arrives stays in its deposit account
        // and is picked up once the canister is topped up.
        if (cycles < Guard.lowCycles) { return #processed(order.status) };
        // Read-only check first, outside any lock: most ticks find nothing.
        let cfg = state.config;
        let bal = try {
          await icp(cfg).icrc1_balance_of({ owner = self; subaccount = ?order.subaccount });
        } catch (_) { return #processed(order.status) };

        // Re-check after the await: the order may have moved on or been removed meanwhile.
        switch (orders.get(id), order.status) {
          case (?_, #awaitingDeposit) {};
          case _ { return #processed(order.status) };
        };
        if (rt.inFlight.contains(id)) { return #busy };

        // Dust (under 0.001 ICP, and never less than two ledger fees) isn't a payment.
        if (bal < Nat.max(Guard.minDepositE8s, 2 * cfg.icpFee + 1)) {
          switch (order.houdiniId) {
            case null {
              // Never paired with a Houdini exchange: no one was told to pay, so drop it.
              let ttl = Nat.min(Guard.unattachedTtlSeconds, cfg.orderTtlSeconds);
              if (Time.now() >= order.createdAt + ttl * 1_000_000_000) {
                orders.remove(id);
                active.remove(id);
                return #notFound;
              };
            };
            case (?_) {
              let deadline = order.createdAt + cfg.orderTtlSeconds * 1_000_000_000;
              if (Time.now() >= deadline) { expire(rt, order, active) };
            };
          };
          return #processed(order.status);
        };
        if (cfg.paused) { return #processed(order.status) };

        if (rt.exec.helpers.size() > 0) {
          // Helper path: no global lock; a free helper does the swap from its own account.
          // (No fallback to the router's own account while helpers are configured: ICPSwap
          // pays out late, and the shared main account can't tell late arrivals apart.)
          let helper = switch (claimHelper(rt)) {
            case (?h) { h };
            case null {
              order.lastCheckedAt := prevChecked;
              return #busy; // all helpers busy; picked up again on the next tick
            };
          };
          rt.inFlight.add(id);
          try {
            await* swapViaHelper(state, fees, rt, active, self, order, bal, helper);
          } finally {
            rt.inFlight.remove(id);
            rt.busyHelpers.remove(helper);
          };
        } else {
          // Legacy path (no helpers configured): swap from the router's main account, one
          // at a time.
          if (state.busy) {
            order.lastCheckedAt := prevChecked;
            return #busy;
          };
          state.busy := true;
          rt.inFlight.add(id);
          try {
            await* swap(state, fees, rt, active, self, order, bal);
          } finally {
            state.busy := false;
            rt.inFlight.remove(id);
          };
        };
      };
      case (#payoutPending p) {
        if (cycles < Guard.criticalCycles) { return #processed(order.status) };
        if (rt.payFromSub.contains(id)) {
          rt.inFlight.add(id);
          try { await* payout(state, active, rt, self, order, p) } finally { rt.inFlight.remove(id) };
        } else {
          if (state.busy) { return #busy };
          state.busy := true;
          rt.inFlight.add(id);
          try { await* payout(state, active, rt, self, order, p) } finally {
            state.busy := false;
            rt.inFlight.remove(id);
          };
        };
      };
      case (#refundPending r) {
        if (cycles < Guard.criticalCycles) { return #processed(order.status) };
        if (r.fromDeposit) {
          rt.inFlight.add(id);
          try { await* refund(state, rt, active, self, order, r) } finally { rt.inFlight.remove(id) };
        } else {
          if (state.busy) { return #busy };
          state.busy := true;
          rt.inFlight.add(id);
          try { await* refund(state, rt, active, self, order, r) } finally {
            state.busy := false;
            rt.inFlight.remove(id);
          };
        };
      };
      case (#swapping _) {
        // Not in flight, yet marked swapping: a previous swap message trapped mid-flight.
        setStatus(order, active, #needsReview("swap interrupted; check the helper, the pool's unused balance and the deposit account"));
      };
      case _ {};
    };
    #processed(order.status);
  };

  // Ends a job's link, only if it is still this order's.
  func unlink(rt : Types.Runtime, helper : Principal, id : Nat) {
    if (rt.helperOrders.get(helper) == ?id) { rt.helperOrders.remove(helper) };
  };

  // Round-robin over free helpers that are neither quarantined nor linked to an order. No
  // await: check-and-claim is atomic.
  func claimHelper(rt : Types.Runtime) : ?Principal {
    let hs = rt.exec.helpers;
    let n = hs.size();
    var k = 0;
    while (k < n) {
      let h = hs[(rt.nextHelper + k) % n];
      if (not rt.busyHelpers.contains(h) and not rt.quarantined.contains(h) and not rt.helperOrders.containsKey(h)) {
        rt.busyHelpers.add(h);
        rt.nextHelper := (rt.nextHelper + k + 1) % n;
        return ?h;
      };
      k += 1;
    };
    null;
  };

  // ---------------------------------------------------------------------------------
  // Helper path: the order's deposit account -> helper -> ICPSwap -> back to the order's
  // deposit account. Everything is settled from that one account, so parallel swaps on
  // different helpers can't mix.
  // ---------------------------------------------------------------------------------
  func swapViaHelper(
    state : Types.RouterState,
    fees : Types.FeeState,
    rt : Types.Runtime,
    active : Set.Set<Nat>,
    self : Principal,
    order : Order,
    bal : Nat,
    helper : Principal,
  ) : async* () {
    let cfg = state.config;
    let fee = cfg.icpFee;
    let nakswapFee = routerFee(fees, bal);
    // Four ICP ledger fees: approving the helper, its transfer_from, its approval of the
    // pool, and the pool's transfer_from.
    let amountIn = minus(bal, 4 * fee + nakswapFee);

    if (bal < cfg.minOrderIcp or amountIn == 0) {
      refundFromDeposit(order, active, cfg, bal, #tooSmall);
      return;
    };
    if (bal > cfg.maxOrderIcp) {
      refundFromDeposit(order, active, cfg, bal, #tooLarge);
      return;
    };

    let p = pool(cfg);
    let (quoteOut, probeOut) = try {
      let q = await p.quote({ amountIn = amountIn.toText(); zeroForOne = cfg.icpIsToken0; amountOutMinimum = "0" });
      let m = await p.quote({ amountIn = probeE8s.toText(); zeroForOne = cfg.icpIsToken0; amountOutMinimum = "0" });
      switch (q, m) {
        case (#ok qo, #ok mo) { (qo, mo) };
        case _ { return };
      };
    } catch (_) { return };

    // Price far worse than its recent average: likely pushed; try again on a later tick.
    if (not priceSane(rt.priceRef, probeOut, Time.now())) { return };
    let impact = impactBps(amountIn, quoteOut, probeOut);
    if (impact > cfg.maxImpactBps) {
      refundFromDeposit(order, active, cfg, bal, #priceImpact({ bps = impact }));
      return;
    };
    let slippageFloor = quoteOut * minus(bpsDenom, cfg.slippageBps) / bpsDenom;
    // What the user must receive, plus the three NAK fees on the way: the pool's withdraw,
    // the helper's return to the deposit account, and the payout.
    let minOut = Nat.max(slippageFloor, if (order.minNakOut == 0) { 0 } else { order.minNakOut + 3 * cfg.nakFee });

    let icpL = icp(cfg);
    let sub = ?order.subaccount;
    let pull = amountIn + 2 * fee;

    // 1. Let this helper (only) take the job's ICP from the deposit account, for 5 minutes.
    // Reuse a live approval from an earlier attempt instead of paying for a new one.
    let existing = try {
      await icpL.icrc2_allowance({ account = { owner = self; subaccount = sub }; spender = { owner = helper; subaccount = null } });
    } catch (_) { { allowance = 0; expires_at = null } };
    let stillValid = existing.allowance >= pull + fee and (switch (existing.expires_at) { case (?t) { t > nowNat64() + 60_000_000_000 }; case null { true } });
    let approved = if stillValid { #Ok(0) } else try {
      await icpL.icrc2_approve({
        from_subaccount = sub;
        spender = { owner = helper; subaccount = null };
        amount = pull + fee;
        expected_allowance = null;
        expires_at = ?(nowNat64() + 300_000_000_000);
        fee = ?fee;
        memo = null;
        created_at_time = null;
      });
    } catch (_) { return };
    switch approved { case (#Ok _) {}; case (#Err _) { return } };

    // 2. Hand the job to the helper. Remember this order's fee in case its funds have to be
    // recovered from the helper later.
    setStatus(order, active, #swapping({ icpIn = amountIn; startedAt = Time.now() }));
    rt.jobFees.add(order.id, nakswapFee);
    // Linked for the whole job, so a helper holding this order's funds (a job cut short by a
    // trap or an upgrade) is never mistaken for one holding a stranger's tokens. Removed
    // again below whenever the job ends with nothing of the order's left in the helper.
    rt.helperOrders.add(helper, order.id);
    let h : Ext.Helper = actor (helper.toText());
    let result = try {
      ?(await h.swap({
        strayTo = { owner = self; subaccount = ?Account.straySubaccount };
        from = { owner = self; subaccount = sub };
        pull;
        amountIn;
        minOut;
        zeroForOne = cfg.icpIsToken0;
        icpFee = fee;
        nakFee = cfg.nakFee;
        returnTo = { owner = self; subaccount = sub };
      }));
    } catch (_) { null };

    let d = switch result {
      case (?(#done d)) { d };
      case (?#busy) {
        // Momentarily unavailable (e.g. a ledger hiccup); nothing moved. Try again later.
        unlink(rt, helper, order.id);
        rt.jobFees.remove(order.id);
        setStatus(order, active, #awaitingDeposit);
        return;
      };
      case (?#dirty _ or ?#notAuthorized) {
        unlink(rt, helper, order.id);
        rt.jobFees.remove(order.id);
        // Holding funds that may be someone's late payout, or misconfigured: nothing moved
        // for this order; stop using this helper until an admin clears it.
        rt.quarantined.add(helper);
        setStatus(order, active, #awaitingDeposit);
        return;
      };
      case null {
        rt.quarantined.add(helper);
        // Outcome unknown. Retry only if the deposit is exactly untouched (bar this
        // attempt's approval fee); otherwise the helper may hold this order's ICP.
        let now = try { await icpL.icrc1_balance_of({ owner = self; subaccount = sub }) } catch (_) { 0 };
        if (now == bal or now + fee == bal) {
          unlink(rt, helper, order.id);
          rt.jobFees.remove(order.id);
          setStatus(order, active, #awaitingDeposit);
          return;
        };
        setStatus(order, active, #needsReview("helper call failed after taking the ICP; recover with helper-recover (helper " # helper.toText() # ")"));
        return;
      };
    };
    if (not d.pulled) {
      unlink(rt, helper, order.id);
      rt.jobFees.remove(order.id);
      setStatus(order, active, #awaitingDeposit); // nothing moved; try again later
      return;
    };
    if (not d.clean) {
      // ICPSwap hasn't finished paying out (or a payout failed on its side). The helper keeps
      // everything together and is out of rotation until an admin recovers it to this order.
      rt.quarantined.add(helper);
      rt.helperOrders.add(helper, order.id);
      setStatus(order, active, #needsReview("helper " # helper.toText() # " holds this order's funds: " # d.note));
      return;
    };

    // 3. Settle from what the helper reports it sent back, not from the raw balance of the
    // deposit account (which anyone can add dust to). The balance only caps the amounts.
    // If the balance can't be read, assume the fee is there (a sweep of a missing fee just fails).
    let icpHere : ?Nat = try { ?(await icpL.icrc1_balance_of({ owner = self; subaccount = sub })) } catch (_) { null };
    settleFromHelper(active, fees, rt, order, cfg, amountIn, nakswapFee, quoteOut, minOut, d, helper, icpHere);
  };

  func settleFromHelper(
    active : Set.Set<Nat>,
    fees : Types.FeeState,
    rt : Types.Runtime,
    order : Order,
    cfg : Types.Config,
    amountIn : Nat,
    nakswapFee : Nat,
    quoteOut : Nat,
    minOut : Nat,
    d : { pulled : Bool; swapped : Bool; nakReturned : Nat; icpReturned : Nat; note : Text; clean : Bool },
    helper : Principal,
    icpHere : ?Nat, // null: the balance couldn't be read; each branch assumes what it expects
  ) {
    // Anything that isn't a clean payout or refund parks the order AND takes the helper out
    // of rotation, linked to this order, in case more of its funds are still on the way.
    func park(why : Text) {
      rt.quarantined.add(helper);
      rt.helperOrders.add(helper, order.id);
      setStatus(order, active, #needsReview(why # " (helper " # helper.toText() # ")"));
    };
    if (d.swapped and d.nakReturned > cfg.nakFee) {
      // Defence in depth: the user's minimum must be met, and no more ICP can come back than
      // the job put in.
      if (d.nakReturned + 2 * cfg.nakFee < minOut or d.icpReturned > amountIn) {
        park("swap result doesn't match this order (NAK " # d.nakReturned.toText() # ", ICP " # d.icpReturned.toText() # "): " # d.note);
        return;
      };
      // Anyone can send tokens to a helper while it works, and it returns everything it
      // holds. So the order is paid at most what its own swap explains: the quote + 5% (room
      // for a favourable move), and never less than the user's minimum. NAK above that stays
      // in the deposit account. ICP that came back with the NAK (a partial fill, or a
      // stranger's tokens) stays there too, and the late-deposit watch swaps or refunds it
      // once the fee has gone. Neither can stall the order or the helper.
      let nakForOrder = Nat.min(d.nakReturned, Nat.max(quoteOut + quoteOut / 20, minOut));
      unlink(rt, helper, order.id);
      rt.jobFees.remove(order.id);
      rt.payFromSub.add(order.id);
      let feeHeld = Nat.min(nakswapFee, icpHere ?? nakswapFee);
      if (feeHeld > cfg.icpFee) { rt.subFees.add(order.id, { amount = feeHeld; to = fees.to; createdAtTime = nowNat64() }) };
      setStatus(order, active, #payoutPending({ icpIn = amountIn; nakAmount = minus(nakForOrder, cfg.nakFee); createdAtTime = nowNat64() }));
    } else if (not d.swapped and d.icpReturned > 0 and d.nakReturned <= Guard.helperDustNak) {
      // ICPSwap refunded the input: return it all, fee included, from the deposit account.
      // (NAK dust a stranger sent the helper meanwhile stays in the deposit account.)
      unlink(rt, helper, order.id);
      rt.jobFees.remove(order.id);
      setStatus(
        order,
        active,
        #refundPending({
          icpAmount = minus(Nat.min(nakswapFee + d.icpReturned, icpHere ?? (nakswapFee + d.icpReturned)), cfg.icpFee);
          fromDeposit = true;
          reason = #swapFailed(if (d.note == "") { "no output received" } else { d.note });
          createdAtTime = nowNat64();
        }),
      );
    } else {
      if (not d.swapped and d.nakReturned > cfg.nakFee) {
        // NAK came back although the pool reported no swap: an admin decides.
        park("swap result doesn't match this order (NAK " # d.nakReturned.toText() # " without a swap): " # d.note);
      } else {
        park("no NAK and no ICP back after swap: " # d.note);
      };
    };
  };

  // ---------------------------------------------------------------------------------
  // Automatic recovery: a helper parked with an order's funds (ICPSwap paid late, or an
  // ICPSwap admin retried a failed payout) hands them to that order's deposit account as
  // soon as ICPSwap is done with it, goes back into rotation, and the order is paid out
  // (NAK) or refunded (ICP) from there. A few per tick.
  // ---------------------------------------------------------------------------------
  public func autoRecover(
    state : Types.RouterState,
    fees : Types.FeeState,
    rt : Types.Runtime,
    orders : Map.Map<Nat, Order>,
    active : Set.Set<Nat>,
    self : Principal,
  ) : async* () {
    if (Cycles.balance() < Guard.criticalCycles) { return };
    let cfg = state.config;
    var n = 0;
    label each for ((helper, id) in rt.helperOrders.entries().toArray().values()) {
      if (n >= 3) { break each };
      if (rt.busyHelpers.contains(helper) or rt.inFlight.contains(id)) { continue each };
      // The list was taken before earlier entries' awaits: the helper may have been cleared
      // and reused for another order since.
      if (rt.helperOrders.get(helper) != ?id) { continue each };
      let o = switch (orders.get(id)) { case (?o) { o }; case null { continue each } };
      switch (o.status) {
        // Results that don't fit the order (too much NAK, or NAK and ICP together) wait for
        // an admin; only "ICPSwap hadn't paid yet" style parks are resolved automatically.
        case (#needsReview m) { if (m.contains(#text "doesn't match") or m.contains(#text "both NAK and ICP")) { continue each } };
        case _ { continue each };
      };
      n += 1;
      rt.busyHelpers.add(helper);
      rt.inFlight.add(id);
      try {
        let h : Ext.Helper = actor (helper.toText());
        let acct = { owner = self; subaccount = ?o.subaccount };
        switch (await h.returnAll(acct, cfg.nakFee, cfg.icpFee)) {
          case (#err _) {}; // ICPSwap not done yet; next tick
          case (#ok _) {
            // Settle only once the helper is empty and ICPSwap is done with it: a transfer
            // that failed inside returnAll leaves funds in the helper, and deciding now would
            // judge this order from a deposit account that's missing them. Until then the
            // helper stays linked to the order and this is retried on the next tick.
            if ((await h.settled(cfg.icpFee, cfg.nakFee)) and rt.helperOrders.get(helper) == ?id) {
            let icpHere = await icp(cfg).icrc1_balance_of(acct);
            let nakHere = await nak(cfg).icrc1_balance_of(acct);
            let stillParked = switch (o.status) { case (#needsReview _) { true }; case _ { false } };
            rt.helperOrders.remove(helper);
            rt.quarantined.remove(helper);
            if (stillParked) {
              let fee = rt.jobFees.get(id) ?? 0;
              rt.jobFees.remove(id);
              if (nakHere > cfg.nakFee) {
                rt.payFromSub.add(id);
                let feeHeld = Nat.min(fee, icpHere);
                if (feeHeld > cfg.icpFee) { rt.subFees.add(id, { amount = feeHeld; to = fees.to; createdAtTime = nowNat64() }) };
                setStatus(o, active, #payoutPending({ icpIn = 0; nakAmount = minus(nakHere, cfg.nakFee); createdAtTime = nowNat64() }));
              } else if (icpHere > cfg.icpFee) {
                setStatus(o, active, #refundPending({ icpAmount = minus(icpHere, cfg.icpFee); fromDeposit = true; reason = #swapFailed("ICPSwap paid late; refunded"); createdAtTime = nowNat64() }));
              };
            };
            };
          };
        };
      } catch (_) {} finally {
        rt.busyHelpers.remove(helper);
        rt.inFlight.remove(id);
      };
    };
  };

  // ---------------------------------------------------------------------------------
  // A helper taken out of rotation without being linked to an order (a hiccup at the start
  // of a job, a rejected call, or tokens a stranger sent it) holds nothing that belongs to an
  // order: dust in it goes to the router's stray account (admin: recoverStray), and once
  // ICPSwap is done with it the helper goes back into rotation. Each such helper costs two
  // ledger queries per tick (only while some are out of rotation).
  // ---------------------------------------------------------------------------------
  public func releaseHelpers(state : Types.RouterState, rt : Types.Runtime, self : Principal) : async* () {
    if (Cycles.balance() < Guard.criticalCycles) { return };
    let cfg = state.config;
    label each for (helper in rt.quarantined.values().toArray().values()) {
      if (rt.helperOrders.containsKey(helper) or rt.busyHelpers.contains(helper)) { continue each };
      if (not rt.exec.helpers.any(func(p : Principal) : Bool = p == helper)) { continue each };
      rt.busyHelpers.add(helper);
      try {
        let h : Ext.Helper = actor (helper.toText());
        let acct = { owner = helper; subaccount = null };
        let (hi, hn) = (await icp(cfg).icrc1_balance_of(acct), await nak(cfg).icrc1_balance_of(acct));
        // Every job links its helper to its order until the order's funds are out, so an
        // unlinked helper holds only tokens a stranger sent it (or leftovers an admin chose
        // to unlink): they go to the router's stray account (admin: recoverStray) and the
        // helper goes back into rotation. Sending tokens to a helper can't stall swaps.
        let ok = if (hi > cfg.icpFee or hn > cfg.nakFee) {
          if (rt.helperOrders.containsKey(helper)) { false } else {
            switch (await h.returnAll({ owner = self; subaccount = ?Account.straySubaccount }, cfg.nakFee, cfg.icpFee)) { case (#ok _) { true }; case (#err _) { false } };
          };
        } else { true };
        if (ok and (await h.settled(cfg.icpFee, cfg.nakFee)) and not rt.helperOrders.containsKey(helper)) {
          rt.quarantined.remove(helper);
        };
      } catch (_) {} finally { rt.busyHelpers.remove(helper) };
    };
  };

  // ICPSwap pays swap output and refunds from a queue after its calls return. "Settled" =
  // nothing pending or failed for `owner` and no unused balance left in the pool.
  public func poolSettled(cfg : Types.Config, owner : Principal) : async* Bool {
    let p = pool(cfg);
    try {
      switch (await p.getTransactionsByOwner(owner)) {
        case (#ok txs) { if (txs.size() > 0) { return false } };
        case (#err _) { return false };
      };
      switch (await p.getUserUnusedBalance(owner)) {
        case (#ok b) {
          let (uIcp, uNak) = if (cfg.icpIsToken0) { (b.balance0, b.balance1) } else { (b.balance1, b.balance0) };
          uIcp <= cfg.icpFee and uNak <= cfg.nakFee;
        };
        case (#err _) { false };
      };
    } catch (_) { false };
  };

  func waitForPool(cfg : Types.Config, owner : Principal) : async* Bool {
    var round = 0;
    while (round < 150) {
      if (await* poolSettled(cfg, owner)) { return true };
      round += 1;
    };
    false;
  };

  // Fees of finished helper-path orders: deposit account -> fee wallet, a few per tick.
  // The deposit account holds only that order's fee by then, so a retry can never pay twice.
  public func sweepOrderFees(
    state : Types.RouterState,
    fees : Types.FeeState,
    rt : Types.Runtime,
    orders : Map.Map<Nat, Order>,
  ) : async* () {
    if (Cycles.balance() < Guard.criticalCycles) { return };
    let cfg = state.config;
    var n = 0;
    label each for (id in rt.subFees.keys().toArray().values()) {
      if (n >= 10) { break each };
      if (rt.inFlight.contains(id)) { continue each };
      // Re-read: another sweep may have settled it since this list was taken.
      let f = switch (rt.subFees.get(id)) { case (?f) { f }; case null { continue each } };
      let o = switch (orders.get(id)) {
        case (?o) { o };
        case null { rt.subFees.remove(id); continue each };
      };
      switch (o.status) {
        // The deposit account holds only this fee (or nothing, if it already left with a
        // refund), so sending from it can never take anyone else's money.
        case (#completed _ or #payoutPending _ or #refunded _) {};
        case _ { continue each };
      };
      n += 1;
      rt.inFlight.add(id);
      let res = try {
        await icp(cfg).icrc1_transfer({
          from_subaccount = ?o.subaccount;
          to = { owner = f.to; subaccount = null };
          amount = minus(f.amount, cfg.icpFee);
          fee = ?cfg.icpFee;
          memo = ?("NAKSWAP-FEE" : Blob);
          created_at_time = ?f.createdAtTime;
        });
      } catch (_) { #Err(#TemporarilyUnavailable) } finally { rt.inFlight.remove(id) };
      switch res {
        case (#Ok _ or #Err(#Duplicate _)) {
          fees.paidTotal += minus(f.amount, cfg.icpFee);
          rt.subFees.remove(id);
        };
        // Past the dedup window: try again with a fresh timestamp. If an earlier attempt did
        // go through, the account is empty and the next one fails with InsufficientFunds.
        case (#Err(#TooOld)) { rt.subFees.add(id, { f with createdAtTime = nowNat64() }) };
        case (#Err(#InsufficientFunds _)) { rt.subFees.remove(id) };
        // BadFee: the ledger's fee changed. Keep the record (so the late-deposit watch never
        // takes the fee for the user's ICP); it goes once the configured fee is updated.
        case (#Err _) {};
      };
    };
  };

  func refundFromDeposit(order : Order, active : Set.Set<Nat>, cfg : Types.Config, bal : Nat, reason : Types.RefundReason) {
    if (bal <= cfg.icpFee) {
      setStatus(order, active, #needsReview("deposit too small to refund"));
    } else {
      setStatus(
        order,
        active,
        #refundPending({
          icpAmount = minus(bal, cfg.icpFee);
          fromDeposit = true;
          reason;
          createdAtTime = nowNat64();
        }),
      );
    };
  };

  // ---------------------------------------------------------------------------------
  // ICP in the deposit subaccount -> ICPSwap -> NAK in the router's main account.
  // ---------------------------------------------------------------------------------
  func swap(state : Types.RouterState, fees : Types.FeeState, rt : Types.Runtime, active : Set.Set<Nat>, self : Principal, order : Order, bal : Nat) : async* () {
    let cfg = state.config;
    let fee = cfg.icpFee;
    // NAKSwap fee stays behind in main when the swap goes through; if the swap fails, it
    // comes back with the rest of the ICP and is refunded too.
    let nakswapFee = routerFee(fees, bal);
    // Three ICP ledger fees are spent: sweep to main, approve, transfer_from by the pool.
    let amountIn = minus(bal, 3 * fee + nakswapFee);

    if (bal < cfg.minOrderIcp or amountIn == 0) {
      refundFromDeposit(order, active, cfg, bal, #tooSmall);
      return;
    };
    if (bal > cfg.maxOrderIcp) {
      refundFromDeposit(order, active, cfg, bal, #tooLarge);
      return;
    };

    // Price checks against the live pool.
    let p = pool(cfg);
    let (quoteOut, probeOut) = try {
      let q = await p.quote({ amountIn = amountIn.toText(); zeroForOne = cfg.icpIsToken0; amountOutMinimum = "0" });
      let m = await p.quote({ amountIn = probeE8s.toText(); zeroForOne = cfg.icpIsToken0; amountOutMinimum = "0" });
      switch (q, m) {
        case (#ok qo, #ok mo) { (qo, mo) };
        case _ { return }; // pool unhappy right now; retry next tick
      };
    } catch (_) { return };

    // Price far worse than its recent average: likely pushed; try again on a later tick.
    if (not priceSane(rt.priceRef, probeOut, Time.now())) { return };
    let impact = impactBps(amountIn, quoteOut, probeOut);
    if (impact > cfg.maxImpactBps) {
      refundFromDeposit(order, active, cfg, bal, #priceImpact({ bps = impact }));
      return;
    };
    let slippageFloor = quoteOut * minus(bpsDenom, cfg.slippageBps) / bpsDenom;
    // minNakOut is what the user must receive; the pool's output also pays the pool's
    // withdraw fee and our payout fee.
    let minOut = Nat.max(slippageFloor, if (order.minNakOut == 0) { 0 } else { order.minNakOut + 2 * cfg.nakFee });

    let icpL = icp(cfg);
    let nakL = nak(cfg);
    let main : Ext.Account = { owner = self; subaccount = null };

    // ICPSwap pays out after its calls return: don't take baselines while an earlier payout
    // to the router may still land.
    if (not (await* poolSettled(cfg, self))) { return };

    // Baselines on the main account (dust from earlier orders is not this order's money).
    let (icpBaseline, nakBaseline) = try {
      (await icpL.icrc1_balance_of(main), await nakL.icrc1_balance_of(main));
    } catch (_) { return };

    // 1. Sweep deposit subaccount -> main. Mark the order first: if the sweep's outcome is
    // unknown (call rejected), the ICP may already be in main and must not be forgotten.
    setStatus(order, active, #swapping({ icpIn = amountIn; startedAt = Time.now() }));
    let sweepAmount = minus(bal, fee);
    let swept = try {
      await icpL.icrc1_transfer({
        from_subaccount = ?order.subaccount;
        to = main;
        amount = sweepAmount;
        fee = ?fee;
        memo = null; // no order number on chain: nothing ties this transfer to an order
        created_at_time = null;
      });
    } catch (e) {
      setStatus(order, active, #needsReview("sweep outcome unknown: " # e.message()));
      return;
    };
    switch swept {
      case (#Ok _) {};
      case (#Err _) {
        // Clean failure: nothing moved, try again next tick.
        setStatus(order, active, #awaitingDeposit);
        return;
      };
    };

    // From here the ICP lives in main; any failure must end in a refund from main.

    // 2. Let the pool pull amountIn (+ its transfer_from fee).
    let approved = try {
      await icpL.icrc2_approve({
        from_subaccount = null;
        spender = { owner = cfg.pool; subaccount = null };
        amount = amountIn + fee;
        expected_allowance = null;
        // Short-lived: if the swap fails before the pool pulls, no allowance lingers on main.
        expires_at = ?(nowNat64() + 300_000_000_000);
        fee = ?fee;
        memo = null; // no order number on chain: nothing ties this transfer to an order
        created_at_time = null;
      });
    } catch (e) { #Err(#GenericError({ error_code = 0; message = e.message() })) };
    switch approved {
      case (#Ok _) {};
      case (#Err _) {
        await* settleFromMain(active, fees, order, cfg, icpL, nakL, main, icpBaseline, nakBaseline, amountIn, nakswapFee, bal, quoteOut, "approve failed");
        return;
      };
    };

    // 3. Swap. ICPSwap refunds the input to us if amountOutMinimum is not met.
    let swapNote = try {
      switch (
        await p.depositFromAndSwap({
          amountIn = amountIn.toText();
          zeroForOne = cfg.icpIsToken0;
          amountOutMinimum = minOut.toText();
          tokenInFee = fee;
          tokenOutFee = cfg.nakFee;
        })
      ) {
        case (#ok _) { "" };
        case (#err(#InternalError m)) { m };
        case (#err(#UnsupportedToken m)) { "unsupported token " # m };
        case (#err(#InsufficientFunds)) { "pool: insufficient funds" };
        case (#err(#CommonError)) { "pool: common error" };
      };
    } catch (e) { "pool call rejected: " # e.message() };

    // 4. Wait for ICPSwap to pay out (or refund), then trust balances, not return values.
    if (not (await* waitForPool(cfg, self))) {
      setStatus(order, active, #needsReview("ICPSwap has not finished paying out to the router: " # swapNote));
      return;
    };
    await* settleFromMain(active, fees, order, cfg, icpL, nakL, main, icpBaseline, nakBaseline, amountIn, nakswapFee, bal, quoteOut, swapNote);
  };

  func settleFromMain(
    active : Set.Set<Nat>,
    fees : Types.FeeState,
    order : Order,
    cfg : Types.Config,
    icpL : Ext.Ledger,
    nakL : Ext.Ledger,
    main : Ext.Account,
    icpBaseline : Nat,
    nakBaseline : Nat,
    amountIn : Nat,
    nakswapFee : Nat,
    deposited : Nat,
    quoteOut : Nat,
    note : Text,
  ) : async* () {
    let (icpNow, nakNow) = try {
      (await icpL.icrc1_balance_of(main), await nakL.icrc1_balance_of(main));
    } catch (_) {
      setStatus(order, active, #needsReview("could not read balances after swap: " # note));
      return;
    };
    let nakGain = minus(nakNow, nakBaseline);
    let icpBack = minus(icpNow, icpBaseline);

    // Sanity bounds: more NAK than the pool quoted (plus 2%), or more ICP back than was
    // deposited, means something else landed in main mid-swap (e.g. a delayed pool withdraw
    // belonging to an earlier order). Don't guess whose it is.
    if (nakGain > quoteOut + quoteOut / 50 or icpBack > deposited) {
      setStatus(
        order,
        active,
        #needsReview("balances moved more than this swap explains (NAK +" # nakGain.toText() # ", ICP +" # icpBack.toText() # "): " # note),
      );
      return;
    };

    if (nakGain > cfg.nakFee) {
      // Swap went through: the fee is the ICP that stayed behind in main.
      fees.accrued += Nat.min(icpBack, nakswapFee);
      setStatus(order, active, #payoutPending({ icpIn = amountIn; nakAmount = minus(nakGain, cfg.nakFee); createdAtTime = nowNat64() }));
    } else if (icpBack > nakswapFee + cfg.icpFee) {
      // ICP came back from the pool (or never left): refund all of it, fee included.
      setStatus(
        order,
        active,
        #refundPending({
          icpAmount = minus(icpBack, cfg.icpFee);
          fromDeposit = false;
          reason = #swapFailed(if (note == "") { "no output received" } else { note });
          createdAtTime = nowNat64();
        }),
      );
    } else {
      // Typical cause: deposit into the pool succeeded but its withdraw leg failed, so the
      // funds sit in the pool as our "unused balance". Needs an operator to withdraw.
      // The withheld fee (if any) is still in main and is part of what forceRefund returns.
      setStatus(order, active, #needsReview("no NAK and no ICP back after swap: " # note));
    };
  };

  // ---------------------------------------------------------------------------------
  // Fee sweep: accrued ICP in main -> fee wallet. Runs under the lock like every other
  // movement out of main. One sweep at a time; its amount, wallet and created_at_time are
  // fixed until it settles, so a retry is deduplicated by the ledger.
  // ---------------------------------------------------------------------------------
  public func runFeeSweep(state : Types.RouterState, fees : Types.FeeState, minGross : Nat) : async* Nat {
    let cfg = state.config;
    if (state.busy or Cycles.balance() < Guard.criticalCycles) { return 0 };
    let sweep = switch (fees.pending) {
      case (?p) { p };
      case null {
        if (fees.accrued < minGross or fees.accrued <= cfg.icpFee) { return 0 };
        let p = { gross = fees.accrued; amount = minus(fees.accrued, cfg.icpFee); to = fees.to; createdAtTime = nowNat64() };
        fees.pending := ?p;
        p;
      };
    };
    state.busy := true;
    let res = try {
      await icp(cfg).icrc1_transfer({
        from_subaccount = null;
        to = { owner = sweep.to; subaccount = null };
        amount = sweep.amount;
        fee = ?cfg.icpFee;
        memo = ?("NAKSWAP-FEE" : Blob);
        created_at_time = ?sweep.createdAtTime;
      });
    } catch (_) {
      #Err(#TemporarilyUnavailable);
    } finally {
      state.busy := false; // released even if handling the reply traps
    };
    switch res {
      case (#Ok _ or #Err(#Duplicate _)) {
        fees.accrued := minus(fees.accrued, sweep.gross);
        fees.paidTotal += sweep.amount;
        fees.pending := null;
        sweep.amount;
      };
      case (#Err(#TooOld)) {
        // Outcome unknowable now; park it for the admin to check on the ledger.
        fees.accrued := minus(fees.accrued, sweep.gross);
        fees.stuck += sweep.gross;
        fees.pending := null;
        0;
      };
      case (#Err(#InsufficientFunds _ or #BadFee _)) {
        // Nothing moved; drop this attempt so the next one is rebuilt from current values.
        fees.pending := null;
        0;
      };
      case (#Err _) { 0 };
    };
  };

  // ---------------------------------------------------------------------------------
  // Payouts and refunds. created_at_time + memo are fixed per order, so a retry after an
  // unknown outcome is deduplicated by the ledger instead of paying twice.
  // ---------------------------------------------------------------------------------
  func payout(
    state : Types.RouterState,
    active : Set.Set<Nat>,
    rt : Types.Runtime,
    self : Principal,
    order : Order,
    p : { icpIn : Nat; nakAmount : Nat; createdAtTime : Nat64 },
  ) : async* () {
    let cfg = state.config;
    let r = try {
      await nak(cfg).icrc1_transfer({
        from_subaccount = if (rt.payFromSub.contains(order.id)) { ?order.subaccount } else { null };
        to = { owner = order.recipient; subaccount = null };
        amount = p.nakAmount;
        fee = ?cfg.nakFee;
        memo = ?Account.orderMemo(self, order.subaccount);
        created_at_time = ?p.createdAtTime;
      });
    } catch (_) { return };
    switch r {
      case (#Ok block or #Err(#Duplicate { duplicate_of = block })) {
        rt.payFromSub.remove(order.id);
        setStatus(order, active, #completed({ icpIn = p.icpIn; nakOut = p.nakAmount; block }));
        watch(rt, order.id);
        rt.stats.swaps += 1;
        rt.stats.icpSwapped += p.icpIn;
        rt.stats.nakDelivered += p.nakAmount;
      };
      case (#Err(#TooOld)) {
        // Dedup window passed without a recorded success; a human must check the ledger.
        setStatus(order, active, #needsReview("payout TooOld; verify on NAK ledger before resending" # (if (rt.revived.contains(order.id)) { " (order was revived after an earlier payout with the same memo: match by amount and time)" } else { "" })));
      };
      case (#Err _) {
        // The ledger refused it (nothing moved). Retry for an hour, then stop and flag it.
        if (failingTooLong(p.createdAtTime)) {
          setStatus(order, active, #needsReview("payout rejected by the NAK ledger for an hour; nothing was sent"));
        };
      };
    };
  };

  func refund(
    state : Types.RouterState,
    rt : Types.Runtime,
    active : Set.Set<Nat>,
    self : Principal,
    order : Order,
    r : {
      icpAmount : Nat;
      fromDeposit : Bool;
      reason : Types.RefundReason;
      createdAtTime : Nat64;
    },
  ) : async* () {
    let cfg = state.config;
    let res = try {
      await icp(cfg).icrc1_transfer({
        from_subaccount = if (r.fromDeposit) { ?order.subaccount } else { null };
        to = { owner = order.refundTo; subaccount = null };
        amount = r.icpAmount;
        fee = ?cfg.icpFee;
        memo = ?Account.orderMemo(self, order.subaccount);
        created_at_time = ?r.createdAtTime;
      });
    } catch (_) { return };
    switch res {
      case (#Ok block or #Err(#Duplicate { duplicate_of = block })) {
        setStatus(order, active, #refunded({ icpAmount = r.icpAmount; reason = r.reason; block }));
        watch(rt, order.id);
      };
      case (#Err(#TooOld)) {
        setStatus(order, active, #needsReview("refund TooOld; verify on ICP ledger before resending" # (if (rt.revived.contains(order.id)) { " (order was revived after an earlier result with the same memo: match by amount and time)" } else { "" })));
      };
      case (#Err _) {
        if (failingTooLong(r.createdAtTime)) {
          setStatus(order, active, #needsReview("refund rejected by the ICP ledger for an hour; nothing was sent"));
        };
      };
    };
  };

};
