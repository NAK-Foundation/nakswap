// The order state machine. Every step that moves funds runs under `state.busy`, so the
// router's main account is only ever touched by one order at a time and balance deltas
// around the ICPSwap call can be attributed to that order.
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
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

  public func minus(a : Nat, b : Nat) : Nat {
    if (a <= b) { 0 } else { (a - b : Int).toNat() };
  };

  public func isActive(status : Status) : Bool {
    switch status {
      case (#awaitingDeposit or #payoutPending _ or #refundPending _) { true };
      case _ { false };
    };
  };

  func nowNat64() : Nat64 { Int.abs(Time.now()).toNat64() };

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
    orders : Map.Map<Nat, Order>,
    active : Set.Set<Nat>,
    self : Principal,
    id : Nat,
  ) : async* Types.PokeResult {
    let order = switch (orders.get(id)) {
      case (?o) { o };
      case null { return #notFound };
    };
    if (state.busy) { return #busy };
    order.lastCheckedAt := Time.now();

    let cycles = Cycles.balance();
    switch (order.status) {
      case (#awaitingDeposit) {
        // Low on cycles: don't start swaps. ICP that arrives stays in its deposit account
        // and is picked up once the canister is topped up.
        if (cycles < Guard.lowCycles) { return #processed(order.status) };
        // Read-only check first, outside the lock: most ticks find nothing.
        let cfg = state.config;
        let bal = try {
          await icp(cfg).icrc1_balance_of({ owner = self; subaccount = ?order.subaccount });
        } catch (_) { return #processed(order.status) };

        if (bal == 0) {
          let deadline = order.createdAt + cfg.orderTtlSeconds * 1_000_000_000;
          if (Time.now() >= deadline) { setStatus(order, active, #expired) };
          return #processed(order.status);
        };
        if (cfg.paused) { return #processed(order.status) };
        // Re-check after the await: another message may have taken the lock or the order.
        if (state.busy) { return #busy };
        switch (order.status) { case (#awaitingDeposit) {}; case _ { return #processed(order.status) } };

        state.busy := true;
        try {
          await* swap(state, active, self, order, bal);
        } finally {
          state.busy := false;
        };
      };
      case (#payoutPending p) {
        if (cycles < Guard.criticalCycles) { return #processed(order.status) };
        state.busy := true;
        try { await* payout(state, active, order, p) } finally { state.busy := false };
      };
      case (#refundPending r) {
        if (cycles < Guard.criticalCycles) { return #processed(order.status) };
        state.busy := true;
        try { await* refund(state, active, order, r) } finally { state.busy := false };
      };
      case (#swapping _) {
        // Only reachable if a previous swap message trapped mid-flight.
        setStatus(order, active, #needsReview("swap interrupted; reconcile pool unused balance and router main account"));
      };
      case _ {};
    };
    #processed(order.status);
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
  func swap(state : Types.RouterState, active : Set.Set<Nat>, self : Principal, order : Order, bal : Nat) : async* () {
    let cfg = state.config;
    let fee = cfg.icpFee;
    // Three ICP ledger fees are spent: sweep to main, approve, transfer_from by the pool.
    let amountIn = minus(bal, 3 * fee);

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
    let minOut = Nat.max(slippageFloor, order.minNakOut);

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
        memo = ?Account.memo(order.id);
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
        expires_at = null;
        fee = ?fee;
        memo = ?Account.memo(order.id);
        created_at_time = null;
      });
    } catch (e) { #Err(#GenericError({ error_code = 0; message = e.message() })) };
    switch approved {
      case (#Ok _) {};
      case (#Err _) {
        await* settleFromMain(active, order, cfg, icpL, nakL, main, icpBaseline, nakBaseline, amountIn, "approve failed");
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
    await* settleFromMain(active, order, cfg, icpL, nakL, main, icpBaseline, nakBaseline, amountIn, swapNote);
  };

  func settleFromMain(
    active : Set.Set<Nat>,
    order : Order,
    cfg : Types.Config,
    icpL : Ext.Ledger,
    nakL : Ext.Ledger,
    main : Ext.Account,
    icpBaseline : Nat,
    nakBaseline : Nat,
    amountIn : Nat,
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

    if (nakGain > cfg.nakFee) {
      setStatus(order, active, #payoutPending({ icpIn = amountIn; nakAmount = minus(nakGain, cfg.nakFee); createdAtTime = nowNat64() }));
    } else if (icpBack > cfg.icpFee) {
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
      setStatus(order, active, #needsReview("no NAK and no ICP back after swap: " # note));
    };
  };

  // ---------------------------------------------------------------------------------
  // Payouts and refunds. created_at_time + memo are fixed per order, so a retry after an
  // unknown outcome is deduplicated by the ledger instead of paying twice.
  // ---------------------------------------------------------------------------------
  func payout(
    state : Types.RouterState,
    active : Set.Set<Nat>,
    order : Order,
    p : { icpIn : Nat; nakAmount : Nat; createdAtTime : Nat64 },
  ) : async* () {
    let cfg = state.config;
    let r = try {
      await nak(cfg).icrc1_transfer({
        from_subaccount = null;
        to = { owner = order.recipient; subaccount = null };
        amount = p.nakAmount;
        fee = ?cfg.nakFee;
        memo = ?Account.memo(order.id);
        created_at_time = ?p.createdAtTime;
      });
    } catch (_) { return };
    switch r {
      case (#Ok block or #Err(#Duplicate { duplicate_of = block })) {
        setStatus(order, active, #completed({ icpIn = p.icpIn; nakOut = p.nakAmount; block }));
      };
      case (#Err(#TooOld)) {
        // Dedup window passed without a recorded success; a human must check the ledger.
        setStatus(order, active, #needsReview("payout TooOld; verify on NAK ledger before resending"));
      };
      case (#Err _) {};
    };
  };

  func refund(
    state : Types.RouterState,
    active : Set.Set<Nat>,
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
        memo = ?Account.memo(order.id);
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
      case (#Err _) {};
    };
  };

};
