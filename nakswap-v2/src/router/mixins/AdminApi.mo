import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Set "mo:core/Set";
import Time "mo:core/Time";
import Account "../../common/Account";
import Ext "../../common/Ext";
import Error "mo:core/Error";
import Text "mo:core/Text";
import Engine "../lib/Engine";
import Guard "../lib/Guard";
import Orders "../lib/Orders";
import Types "../types";

mixin (
  state : Types.RouterState,
  fees : Types.FeeState,
  privacy : Types.PrivacyState,
  orders : Map.Map<Nat, Types.Order>,
  active : Set.Set<Nat>,
  self : Principal,
) {

  public query func getConfig() : async Types.Config { state.config };

  // Guard rails against a typo (or a stolen admin session) bricking or redirecting the
  // router. Ledgers and pool are fixed here; changing them takes a code upgrade.
  func validConfig(c : Types.Config) : Bool {
    let cur = state.config;
    c.icpLedger == cur.icpLedger and c.nakLedger == cur.nakLedger and c.pool == cur.pool and c.icpIsToken0 == cur.icpIsToken0
    // Ledger fees are set by the ledgers; changing them here would only break payouts.
    and c.icpFee == cur.icpFee and c.nakFee == cur.nakFee
    and c.admin != self and c.operators.all(func(p : Principal) : Bool = p != self)
    and not c.admin.isAnonymous() and c.operators.size() >= 1 and c.operators.size() <= 5
    and c.operators.all(func(p : Principal) : Bool = not p.isAnonymous())
    and c.icpFee > 0 and c.icpFee <= 1_000_000 and c.nakFee <= 100_000_000
    and c.slippageBps <= 1_000 and c.maxImpactBps <= 2_000
    and c.minOrderIcp >= 10 * c.icpFee and c.minOrderIcp < c.maxOrderIcp and c.maxOrderIcp <= 1_000 * 100_000_000
    and c.orderTtlSeconds <= 7 * 86_400;
  };

  public shared ({ caller }) func setConfig(cfg : Types.Config) : async Bool {
    if (not Orders.isAdmin(state.config, caller)) { return false };
    if (not validConfig(cfg)) { return false };
    state.config := cfg;
    true;
  };

  public shared ({ caller }) func setPaused(paused : Bool) : async Bool {
    if (not Orders.isAdmin(state.config, caller)) { return false };
    state.config := { state.config with paused };
    true;
  };

  // Put an expired / needs-review order back in the queue, e.g. Houdini paid after the TTL.
  public shared ({ caller }) func reopen(id : Nat) : async ?Types.Status {
    if (not Orders.isAdmin(state.config, caller)) { return null };
    switch (orders.get(id)) {
      case (?o) {
        switch (o.status) {
          case (#expired or #needsReview _) { Engine.setStatus(o, active, #awaitingDeposit) };
          case _ {};
        };
        ?o.status;
      };
      case null { null };
    };
  };

  // Manual resolution for #needsReview / #expired: send `icpAmount` back to the order's
  // refundTo, from its deposit subaccount or from the router's main account. Capped by what
  // is actually there: a deposit refund by the deposit's balance, a main-account refund by
  // main's ICP minus the fees that belong to the fee wallet. Refused when a NAK payout may
  // already have gone out (check the NAK ledger, then use forcePayout or nothing).
  public shared ({ caller }) func forceRefund(id : Nat, icpAmount : Nat, fromDeposit : Bool) : async ?Types.Status {
    if (not Orders.isAdmin(state.config, caller)) { return null };
    let cfg = state.config;
    if (icpAmount <= cfg.icpFee) { return null };
    let o = switch (orders.get(id)) { case (?o) { o }; case null { return null } };
    if (not refundable(o.status)) { return ?o.status };
    let ledger : Ext.Ledger = actor (cfg.icpLedger.toText());
    if (fromDeposit) {
      let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = ?o.subaccount });
      if (icpAmount + cfg.icpFee > bal) { return ?o.status };
    } else {
      if (state.busy) { return ?o.status };
      let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = null });
      if (icpAmount + cfg.icpFee + fees.accrued > bal) { return ?o.status };
    };
    if (not refundable(o.status)) { return ?o.status }; // re-check after the await
    Engine.setStatus(
      o,
      active,
      #refundPending({
        icpAmount;
        fromDeposit;
        reason = #admin;
        createdAtTime = Int.abs(Time.now()).toNat64();
      }),
    );
    ?o.status;
  };

  func refundable(s : Types.Status) : Bool {
    switch s {
      case (#expired) { true };
      case (#needsReview r) { not r.startsWith(#text "payout") };
      case _ { false };
    };
  };

  // For a #needsReview order whose NAK is in the router's main account (e.g. a payout the
  // ledger kept rejecting, or NAK withdrawn from the pool with withdrawFromPool): pay
  // `nakAmount` to the order's recipient. Capped by main's NAK balance.
  public shared ({ caller }) func forcePayout(id : Nat, nakAmount : Nat) : async ?Types.Status {
    if (not Orders.isAdmin(state.config, caller)) { return null };
    let cfg = state.config;
    if (nakAmount == 0) { return null };
    let o = switch (orders.get(id)) { case (?o) { o }; case null { return null } };
    switch (o.status) { case (#needsReview _) {}; case _ { return ?o.status } };
    if (state.busy) { return ?o.status };
    let ledger : Ext.Ledger = actor (cfg.nakLedger.toText());
    let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = null });
    if (nakAmount + cfg.nakFee > bal) { return ?o.status };
    switch (o.status) { case (#needsReview _) {}; case _ { return ?o.status } };
    Engine.setStatus(o, active, #payoutPending({ icpIn = 0; nakAmount; createdAtTime = Int.abs(Time.now()).toNat64() }));
    ?o.status;
  };

  // What ICPSwap holds for the router as "unused balance" (left behind by a failed withdraw).
  public shared ({ caller }) func poolUnusedBalance() : async Result.Result<{ icp : Nat; nak : Nat }, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    let cfg = state.config;
    let p : Ext.SwapPool = actor (cfg.pool.toText());
    switch (await p.getUserUnusedBalance(self)) {
      case (#ok b) {
        #ok(if (cfg.icpIsToken0) { { icp = b.balance0; nak = b.balance1 } } else { { icp = b.balance1; nak = b.balance0 } });
      };
      case (#err _) { #err("pool returned an error") };
    };
  };

  // Pull unused balance out of the pool into the router's main account, under the swap lock
  // so it can't land in the middle of another order's swap. Then resolve the order it
  // belongs to with forcePayout / forceRefund.
  public shared ({ caller }) func withdrawFromPool(icpToken : Bool, amount : Nat) : async Result.Result<Nat, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    if (state.busy) { return #err("a swap is running; try again in a minute") };
    let cfg = state.config;
    let p : Ext.SwapPool = actor (cfg.pool.toText());
    state.busy := true;
    try {
      let r = await p.withdraw({
        token = (if icpToken { cfg.icpLedger } else { cfg.nakLedger }).toText();
        fee = if icpToken { cfg.icpFee } else { cfg.nakFee };
        amount;
      });
      switch r {
        case (#ok n) { #ok(n) };
        case (#err(#InternalError m)) { #err(m) };
        case (#err _) { #err("pool refused the withdraw") };
      };
    } catch (e) {
      #err("pool call failed: " # e.message());
    } finally {
      state.busy := false;
    };
  };

  public query ({ caller }) func listOrders(fromId : Nat, limit : Nat) : async [Types.OrderView] {
    if (not Orders.isOperator(state.config, caller)) { return [] };
    let out = Map.empty<Nat, Types.OrderView>();
    for ((id, o) in orders.entriesFrom(fromId)) {
      if (out.size() >= Nat.min(limit, 100)) { break };
      out.add(id, o.toView());
    };
    out.values().toArray();
  };

  public query ({ caller }) func activeOrderIds() : async [Nat] {
    if (not Orders.isOperator(state.config, caller)) { return [] };
    active.values().toArray();
  };

  // Public health check: the relay reads it to explain why swaps are paused.
  public query func health() : async Types.Health {
    let cycles = Cycles.balance();
    {
      cycles;
      lowCyclesThreshold = Guard.lowCycles;
      acceptingOrders = not state.config.paused and cycles >= Guard.lowCycles;
      paused = state.config.paused;
      activeOrders = active.size();
      nextOrderId = state.nextId;
      feeBps = fees.bps;
    };
  };

  // ICP that landed in a deposit account with no order to handle it (an order that was
  // never paired with Houdini and got cleaned up, or one already finished). Sends the whole
  // balance, minus the ledger fee, to `to`.
  public shared ({ caller }) func recoverDeposit(id : Nat, to : Principal) : async Result.Result<Nat, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    if (to.isAnonymous()) { return #err("anonymous destination") };
    let sub = switch (orders.get(id)) {
      case null {
        if (privacy.secret.size() < 24 or id >= state.nextId) { return #err("no such order") };
        Account.depositSubaccount(self, privacy.secret, id);
      };
      case (?o) {
        switch (o.status) {
          case (#completed _ or #refunded _ or #expired or #needsReview _) { o.subaccount };
          case _ { return #err("order is still being processed") };
        };
      };
    };
    let cfg = state.config;
    let ledger : Ext.Ledger = actor (cfg.icpLedger.toText());
    let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = ?sub });
    if (bal <= cfg.icpFee) { return #err("nothing to recover") };
    switch (
      await ledger.icrc1_transfer({
        from_subaccount = ?sub;
        to = { owner = to; subaccount = null };
        amount = bal - cfg.icpFee;
        fee = ?cfg.icpFee;
        memo = null;
        created_at_time = null;
      })
    ) {
      case (#Ok _) { #ok(bal - cfg.icpFee) };
      case (#Err _) { #err("ledger transfer failed") };
    };
  };

  // ---- NAKSwap fee ----
  public query func feeStatus() : async Types.FeeStatus {
    {
      bps = fees.bps;
      to = fees.to;
      accrued = fees.accrued;
      paidTotal = fees.paidTotal;
      stuck = fees.stuck;
      pending = fees.pending;
      autoSweepAt = Engine.feeAutoSweepE8s;
    };
  };

  // bps of the ICP each completed swap brings in (100 = 1%), capped at 5%. Takes effect for
  // swaps that start after the call; a change of wallet applies from the next sweep.
  public shared ({ caller }) func setFee(bps : Nat, to : Principal) : async Bool {
    if (not Orders.isAdmin(state.config, caller)) { return false };
    if (bps > Engine.feeMaxBps or to.isAnonymous() or to == self) { return false };
    fees.bps := bps;
    fees.to := to;
    true;
  };

  // Send whatever has accrued now instead of waiting for the automatic threshold.
  public shared ({ caller }) func sweepFees() : async Nat {
    if (not Orders.isAdmin(state.config, caller)) { return 0 };
    await* Engine.runFeeSweep(state, fees, 2 * state.config.icpFee);
  };

  // After checking the ICP ledger: `stuck` e8s either reached the fee wallet (delivered =
  // true) or are still in main and go back to `accrued`.
  public shared ({ caller }) func resolveStuckFees(delivered : Bool) : async Bool {
    if (not Orders.isAdmin(state.config, caller)) { return false };
    if (delivered) { fees.paidTotal += fees.stuck } else { fees.accrued += fees.stuck };
    fees.stuck := 0;
    true;
  };
};
