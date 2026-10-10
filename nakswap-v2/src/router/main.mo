// NAKSwap v2 router: Houdini delivers ICP to a per-order deposit account owned by this
// canister; the canister swaps it for NAK on ICPSwap and sends NAK to the user's principal.
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Timer "mo:core/Timer";
import Engine "lib/Engine";
import AdminApi "mixins/AdminApi";
import OrdersApi "mixins/OrdersApi";
import Types "types";

actor class Router(init : Types.Config, tickSeconds : Nat) = this {

  let state : Types.RouterState = { var config = init; var nextId = 0; var busy = false };
  let orders = Map.empty<Nat, Types.Order>();
  let active = Set.empty<Nat>();

  transient let self = Principal.fromActor(this);

  include OrdersApi(state, orders, active, self);
  include AdminApi(state, orders, active);

  // Background worker: walks active orders, a few per tick. tickSeconds = 0 disables it
  // (tests drive the state machine through `poke` instead).
  transient let maxPerTick = 10;

  func tick() : async () {
    var n = 0;
    for (id in active.values().toArray().values()) {
      if (n >= maxPerTick) { return };
      ignore await* Engine.step(state, orders, active, self, id);
      n += 1;
    };
  };

  transient let _timer : ?Timer.TimerId = if (tickSeconds > 0) {
    ?Timer.recurringTimer<system>(#seconds(tickSeconds), tick);
  } else { null };
};
