// The order state machine. Every step that moves funds runs under `state.busy`, so the
// router's main account is only ever touched by one order at a time and balance deltas
// around the ICPSwap call can be attributed to that order.
import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
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

  func icp(cfg : Types.Config) : Ext.Ledger = actor (cfg.icpLedger.toText());
  func nak(cfg : Types.Config) : Ext.Ledger = actor (cfg.nakLedger.toText());
  func pool(cfg : Types.Config) : Ext.SwapPool = actor (cfg.pool.toText());

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

        if (bal == 0) {
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
              if (Time.now() >= deadline) { setStatus(order, active, #expired) };
            };
          };
          return #processed(order.status);
        };
        if (cfg.paused) { return #processed(order.status) };

        if (usableHelpers(rt) > 0) {
          // Helper path: no global lock; a free helper does the swap from its own account.
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
          // Legacy path (no helpers, or every helper quarantined): swap from the router's
          // main account, one at a time.
          if (state.busy) {
            order.lastCheckedAt := prevChecked;
            return #busy;
          };
          state.busy := true;
          rt.inFlight.add(id);
          try {
            await* swap(state, fees, active, self, order, bal);
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
          try { await* refund(state, active, self, order, r) } finally { rt.inFlight.remove(id) };
        } else {
          if (state.busy) { return #busy };
          state.busy := true;
          rt.inFlight.add(id);
          try { await* refund(state, active, self, order, r) } finally {
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

  public func usableHelpers(rt : Types.Runtime) : Nat {
    rt.exec.helpers.filter(func(h : Principal) : Bool = not rt.quarantined.contains(h)).size();
  };

  // Round-robin over free, non-quarantined helpers. No await: check-and-claim is atomic.
  func claimHelper(rt : Types.Runtime) : ?Principal {
    let hs = rt.exec.helpers;
    let n = hs.size();
    var k = 0;
    while (k < n) {
      let h = hs[(rt.nextHelper + k) % n];
      if (not rt.busyHelpers.contains(h) and not rt.quarantined.contains(h)) {
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

    // 2. Hand the job to the helper.
    setStatus(order, active, #swapping({ icpIn = amountIn; startedAt = Time.now() }));
    let h : Ext.Helper = actor (helper.toText());
    let result = try {
      ?(await h.swap({
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

    let note = switch result {
      case (?(#done d)) {
        // A helper that may still hold anything (its own account or the pool) is taken out
        // of rotation until an admin returns those funds and clears it.
        if (not d.clean) { rt.quarantined.add(helper) };
        if (not d.pulled) {
          // Nothing moved (only the approval fee); try again later.
          setStatus(order, active, #awaitingDeposit);
          return;
        };
        d.note;
      };
      case (?#dirty _ or ?#busy or ?#notAuthorized) {
        // Not usable right now (or misconfigured): nothing moved; stop using it.
        rt.quarantined.add(helper);
        setStatus(order, active, #awaitingDeposit);
        return;
      };
      case null {
        rt.quarantined.add(helper);
        // Outcome unknown. If the deposit is untouched (bar the approval fee), retry later.
        let now = try { await icpL.icrc1_balance_of({ owner = self; subaccount = sub }) } catch (_) { 0 };
        if (now + fee >= bal) {
          setStatus(order, active, #awaitingDeposit);
          return;
        };
        "helper call failed after taking the ICP";
      };
    };

    // 3. Settle from the deposit account alone.
    await* settleFromSub(active, fees, rt, order, cfg, self, bal, amountIn, nakswapFee, quoteOut, minOut, helper, note);
  };

  func settleFromSub(
    active : Set.Set<Nat>,
    fees : Types.FeeState,
    rt : Types.Runtime,
    order : Order,
    cfg : Types.Config,
    self : Principal,
    deposited : Nat,
    amountIn : Nat,
    nakswapFee : Nat,
    quoteOut : Nat,
    minOut : Nat,
    helper : Principal,
    note : Text,
  ) : async* () {
    let acct = { owner = self; subaccount = ?order.subaccount };
    let (icpHere, nakHere) = try {
      (await icp(cfg).icrc1_balance_of(acct), await nak(cfg).icrc1_balance_of(acct));
    } catch (_) {
      setStatus(order, active, #needsReview("could not read balances after swap: " # note));
      return;
    };
    // Sanity bounds, as on the legacy path: anything more than this swap can explain (e.g.
    // a delayed pool withdraw that reached the helper) is left for the admin to attribute.
    if (nakHere > quoteOut + quoteOut / 50 or icpHere > deposited) {
      setStatus(order, active, #needsReview("balances moved more than this swap explains (NAK " # nakHere.toText() # ", ICP " # icpHere.toText() # "): " # note));
      return;
    };
    if (nakHere > cfg.nakFee) {
      // Pay out only what a clean swap of this order explains: at least the pool's minimum
      // (less the two NAK transfers on the way back) and no ICP beyond the fee.
      if (nakHere + 2 * cfg.nakFee < minOut or icpHere > nakswapFee + cfg.icpFee) {
        setStatus(order, active, #needsReview("swap result doesn't match this order (NAK " # nakHere.toText() # ", ICP " # icpHere.toText() # "): " # note));
        return;
      };
      rt.payFromSub.add(order.id);
      let feeHeld = Nat.min(icpHere, nakswapFee);
      if (feeHeld > cfg.icpFee) { rt.subFees.add(order.id, { amount = feeHeld; to = fees.to; createdAtTime = nowNat64() }) };
      setStatus(order, active, #payoutPending({ icpIn = amountIn; nakAmount = minus(nakHere, cfg.nakFee); createdAtTime = nowNat64() }));
    } else if (icpHere > nakswapFee + cfg.icpFee) {
      // ICP came back (or never left): refund all of it, fee included, from the deposit account.
      setStatus(
        order,
        active,
        #refundPending({
          icpAmount = minus(icpHere, cfg.icpFee);
          fromDeposit = true;
          reason = #swapFailed(if (note == "") { "no output received" } else { note });
          createdAtTime = nowNat64();
        }),
      );
    } else {
      setStatus(order, active, #needsReview("no NAK and no ICP back after swap (helper " # helper.toText() # "): " # note));
    };
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
        case (#Err(#InsufficientFunds _ or #BadFee _)) { rt.subFees.remove(id) };
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
  func swap(state : Types.RouterState, fees : Types.FeeState, active : Set.Set<Nat>, self : Principal, order : Order, bal : Nat) : async* () {
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

    // 4. Trust balances, not return values.
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
      state.busy := false;
      return 0;
    };
    state.busy := false;
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
      };
      case (#Err(#TooOld)) {
        // Dedup window passed without a recorded success; a human must check the ledger.
        setStatus(order, active, #needsReview("payout TooOld; verify on NAK ledger before resending"));
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
      };
      case (#Err(#TooOld)) {
        setStatus(order, active, #needsReview("refund TooOld; verify on ICP ledger before resending"));
      };
      case (#Err _) {
        if (failingTooLong(r.createdAtTime)) {
          setStatus(order, active, #needsReview("refund rejected by the ICP ledger for an hour; nothing was sent"));
        };
      };
    };
  };

};
