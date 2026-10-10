import Cycles "mo:core/Cycles";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Result "mo:core/Result";
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
  self : Principal,
) {

  // Called by the relay before it asks Houdini for an exchange. The returned
  // depositAccountId is what goes into Houdini's `addressTo`.
  public shared ({ caller }) func createOrder(args : Types.CreateOrderArgs) : async Result.Result<Types.OrderView, Types.CreateOrderError> {
    let cfg = state.config;
    if (not Orders.isOperator(cfg, caller)) { return #err(#notAuthorized) };
    // Low cycles counts as paused: no new orders until the canister is topped up.
    if (cfg.paused or Cycles.balance() < Guard.lowCycles) { return #err(#paused) };
    if (args.recipient.isAnonymous()) { return #err(#anonymousRecipient) };
    let id = state.nextId;
    state.nextId += 1;
    let order = Orders.create(id, self, args);
    orders.add(id, order);
    active.add(id);
    #ok(order.toView());
  };

  public shared ({ caller }) func attachHoudini(id : Nat, houdiniId : Text) : async Bool {
    if (not Orders.isOperator(state.config, caller)) { return false };
    switch (orders.get(id)) {
      case (?o) { o.houdiniId := ?houdiniId; true };
      case null { false };
    };
  };

  public query func getOrder(id : Nat) : async ?Types.OrderView {
    switch (orders.get(id)) {
      case (?o) { ?o.toView() };
      case null { null };
    };
  };

  // Anyone may nudge an order forward (e.g. the UI after Houdini reports FINISHED).
  // Throttled per order so it cannot be used to burn cycles on ledger calls.
  public shared ({ caller }) func poke(id : Nat) : async Types.PokeResult {
    switch (orders.get(id)) {
      case null { return #notFound };
      case (?o) {
        let isOp = Orders.isOperator(state.config, caller);
        if (not isOp and Time.now() - o.lastCheckedAt < 10_000_000_000) { return #tooSoon };
      };
    };
    await* Engine.step(state, orders, active, self, id);
  };
};
