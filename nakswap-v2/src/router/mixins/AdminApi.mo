import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Time "mo:core/Time";
import Engine "../lib/Engine";
import Guard "../lib/Guard";
import Orders "../lib/Orders";
import Types "../types";

mixin (
  state : Types.RouterState,
  fees : Types.FeeState,
  orders : Map.Map<Nat, Types.Order>,
  active : Set.Set<Nat>,
) {

  public query func getConfig() : async Types.Config { state.config };

  // Guard rails against a typo (or a stolen admin session) bricking or redirecting the
  // router. Ledgers and pool are fixed here; changing them takes a code upgrade.
  func validConfig(c : Types.Config) : Bool {
    let cur = state.config;
    c.icpLedger == cur.icpLedger and c.nakLedger == cur.nakLedger and c.pool == cur.pool and c.icpIsToken0 == cur.icpIsToken0
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

  // Manual resolution for #needsReview: send `icpAmount` back to the order's refundTo,
  // from its deposit subaccount or from the router's main account.
  public shared ({ caller }) func forceRefund(id : Nat, icpAmount : Nat, fromDeposit : Bool) : async ?Types.Status {
    if (not Orders.isAdmin(state.config, caller)) { return null };
    if (icpAmount <= state.config.icpFee) { return null };
    switch (orders.get(id)) {
      case (?o) {
        switch (o.status) {
          case (#needsReview _ or #expired) {
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
          };
          case _ {};
        };
        ?o.status;
      };
      case null { null };
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
    if (bps > Engine.feeMaxBps or to.isAnonymous()) { return false };
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
