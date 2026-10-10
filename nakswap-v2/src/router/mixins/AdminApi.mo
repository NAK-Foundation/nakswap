import Cycles "mo:core/Cycles";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Set "mo:core/Set";
import Time "mo:core/Time";
import Engine "../lib/Engine";
import Guard "../lib/Guard";
import Orders "../lib/Orders";
import Types "../types";

mixin (
  state : Types.RouterState,
  orders : Map.Map<Nat, Types.Order>,
  active : Set.Set<Nat>,
) {

  public query func getConfig() : async Types.Config { state.config };

  public shared ({ caller }) func setConfig(cfg : Types.Config) : async Bool {
    if (not Orders.isAdmin(state.config, caller)) { return false };
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
      if (out.size() >= limit) { break };
      out.add(id, o.toView());
    };
    out.values().toArray();
  };

  public query func activeOrderIds() : async [Nat] { active.values().toArray() };

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
    };
  };
};
