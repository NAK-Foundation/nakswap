import Cycles "mo:core/Cycles";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Random "mo:core/Random";
import Result "mo:core/Result";
import Set "mo:core/Set";
import Time "mo:core/Time";
import Account "../../common/Account";
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

  // Called by the relay before it asks Houdini for an exchange. The returned
  // depositAccountId is what goes into Houdini's `addressTo`.
  public shared ({ caller }) func createOrder(args : Types.CreateOrderArgs) : async Result.Result<Types.OrderView, Types.CreateOrderError> {
    let cfg = state.config;
    if (not Orders.isOperator(cfg, caller)) { return #err(#notAuthorized) };
    // Low cycles counts as paused: no new orders until the canister is topped up.
    if (cfg.paused or Cycles.balance() < Guard.lowCycles) { return #err(#paused) };
    // First order after install: fetch the random secret behind deposit subaccounts.
    if (privacy.secret.size() < 24) {
      let r = await Random.blob();
      if (privacy.secret.size() < 24) { privacy.secret := r };
    };
    if (args.recipient.isAnonymous()) { return #err(#anonymousRecipient) };
    // Paying the router itself would strand the NAK / ICP in its main account.
    if (args.recipient == self or args.refundTo == ?self) { return #err(#invalidRecipient) };
    switch (args.refundTo) { case (?r) { if (r.isAnonymous()) { return #err(#anonymousRecipient) } }; case null {} };
    if (active.size() >= Guard.maxOpenOrders) { return #err(#tooManyOpenOrders) };
    let id = state.nextId;
    state.nextId += 1;
    let order = Orders.create(id, self, Account.depositSubaccount(self, privacy.secret, id), args);
    orders.add(id, order);
    active.add(id);
    #ok(order.toView());
  };

  public shared ({ caller }) func attachHoudini(id : Nat, houdiniId : Text) : async Bool {
    if (not Orders.isOperator(state.config, caller)) { return false };
    if (houdiniId.size() == 0 or houdiniId.size() > 64) { return false };
    switch (orders.get(id)) {
      case (?o) {
        switch (o.houdiniId, o.status) {
          case (?h, _) { h == houdiniId }; // idempotent; never re-pointed
          case (null, #awaitingDeposit) { o.houdiniId := ?houdiniId; true };
          case _ { false };
        };
      };
      case null { false };
    };
  };

  // Operators and admin only: order ids are sequential, so a public getOrder would let anyone
  // list every user's principal. The relay serves each order to its owner.
  public query ({ caller }) func getOrder(id : Nat) : async ?Types.OrderView {
    if (not Orders.isOperator(state.config, caller)) { return null };
    switch (orders.get(id)) {
      case (?o) { ?o.toView() };
      case null { null };
    };
  };

  // The relay (operator) nudges an order once Houdini reports the ICP sent; the background
  // worker covers everything else. Not public: every poke can cost a ledger call.
  public shared ({ caller }) func poke(id : Nat) : async Types.PokeResult {
    if (not Orders.isOperator(state.config, caller)) { return #notAuthorized };
    // The relay may nudge an order at most every 5 s (the admin isn't throttled).
    if (not Orders.isAdmin(state.config, caller)) {
      switch (orders.get(id)) {
        case (?o) { if (Time.now() - o.lastCheckedAt < 5_000_000_000) { return #tooSoon } };
        case null {};
      };
    };
    await* Engine.step(state, fees, orders, active, self, id);
  };
};
