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

  // Background worker: walks active orders, a few per tick. tickSeconds = 0 disables it
  // (tests drive the state machine through `poke` instead).
  transient let maxPerTick = 10;

  func tick() : async () {
    var n = 0;
    label walk for (id in active.values().toArray().values()) {
      if (n >= maxPerTick) { break walk };
      ignore await* Engine.step(state, fees, orders, active, self, id);
      n += 1;
    };
    ignore await* Engine.runFeeSweep(state, fees, Engine.feeAutoSweepE8s);
  };

  transient let _timer : ?Timer.TimerId = if (tickSeconds > 0) {
    ?Timer.recurringTimer<system>(#seconds(tickSeconds), tick);
  } else { null };
};
