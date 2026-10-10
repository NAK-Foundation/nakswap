// NAKSwap v2 router: Houdini delivers ICP to a per-order deposit account owned by this
// canister; the canister swaps it for NAK on ICPSwap and sends NAK to the user's principal.
import Array "mo:core/Array";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Time "mo:core/Time";
import Timer "mo:core/Timer";
import Engine "lib/Engine";
import Guard "lib/Guard";
import Orders "lib/Orders";
import AdminApi "mixins/AdminApi";
import OrdersApi "mixins/OrdersApi";
import Types "types";

actor class Router(init : Types.Config, tickSeconds : Nat) = this {

  let state : Types.RouterState = { var config = init; var nextId = 0; var busy = false };
  let orders = Map.empty<Nat, Types.Order>();
  let active = Set.empty<Nat>();
  // Added after the first mainnet install: a new stable field, initialised on upgrade.
  // Default fee 1% to the admin principal; change with setFee.
  let fees : Types.FeeState = {
    var bps = 100;
    var to = state.config.admin;
    var accrued = 0;
    var paidTotal = 0;
    var stuck = 0;
    var pending = null;
  };

  transient let self = Principal.fromActor(this);

  // Runs on install and on every upgrade: a lock left set by an interrupted swap would
  // otherwise block the router forever. Interrupted swaps surface as #needsReview.
  state.busy := false;

  include OrdersApi(state, fees, orders, active, self);
  include AdminApi(state, fees, orders, active);

  // Ingress filter, run before a message is accepted, so rejected calls cost the canister
  // nothing. Every update method is for the relay, the admin or a controller; everyone else
  // (and anything oversized) is turned away here. Public queries are unaffected.
  system func inspect({ caller : Principal; arg : Blob }) : Bool {
    arg.size() <= Guard.maxArgBytes and Orders.isOperator(state.config, caller);
  };

  // Background worker. Money already in flight (payouts, refunds) goes first; then deposit
  // checks, each order at most once a minute and least recently checked first, so a pile of
  // orders can neither starve real ones nor make the router poll the ledger nonstop.
  // tickSeconds = 0 disables it (tests drive the state machine through `poke`).
  func tick() : async () {
    let ids = active.values().toArray();
    var n = 0;
    label pay for (id in ids.values()) {
      if (n >= Guard.maxPerTick) { break pay };
      switch (orders.get(id)) {
        case (?o) {
          switch (o.status) {
            case (#payoutPending _ or #refundPending _) {
              ignore await* Engine.step(state, fees, orders, active, self, id);
              n += 1;
            };
            case _ {};
          };
        };
        case null { active.remove(id) };
      };
    };

    let now = Time.now();
    let due = ids.filter(
      func(id : Nat) : Bool {
        switch (orders.get(id)) {
          case (?o) {
            switch (o.status) {
              case (#awaitingDeposit or #swapping _) { now - o.lastCheckedAt >= Guard.recheckNanos };
              case _ { false };
            };
          };
          case null { false };
        };
      }
    );
    func checkedAt(id : Nat) : Int {
      switch (orders.get(id)) { case (?o) { o.lastCheckedAt }; case null { 0 } };
    };
    let ordered = due.sort(func(a : Nat, b : Nat) : Order.Order = Int.compare(checkedAt(a), checkedAt(b)));
    n := 0;
    label deposits for (id in ordered.values()) {
      if (n >= Guard.maxPerTick) { break deposits };
      ignore await* Engine.step(state, fees, orders, active, self, id);
      n += 1;
    };

    ignore await* Engine.runFeeSweep(state, fees, Engine.feeAutoSweepE8s);
  };

  transient let _timer : ?Timer.TimerId = if (tickSeconds > 0) {
    ?Timer.recurringTimer<system>(#seconds(tickSeconds), tick);
  } else { null };
};
