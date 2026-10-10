// NAKSwap v2 router: Houdini delivers ICP to a per-order deposit account owned by this
// canister; the canister swaps it for NAK on ICPSwap and sends NAK to the user's principal.
import Array "mo:core/Array";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Random "mo:core/Random";
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

  // Added for unlinkable deposit accounts; the secret is fetched from the IC's randomness.
  let privacy : Types.PrivacyState = { var secret = ""; var redactCursor = 0 };

  // Added with the swap helpers: helper list, orders paying out from their own deposit
  // account, and fees waiting in finished orders' deposit accounts.
  let exec : Types.ExecState = { var helpers = [] };
  let payFromSub = Set.empty<Nat>();
  let subFees = Map.empty<Nat, Types.SubFee>();
  let quarantined = Set.empty<Principal>();

  transient let self = Principal.fromActor(this);
  transient let rt : Types.Runtime = {
    exec;
    payFromSub;
    subFees;
    inFlight = Set.empty<Nat>();
    busyHelpers = Set.empty<Principal>();
    quarantined;
    var nextHelper = 0;
  };

  // Runs on install and on every upgrade: a lock left set by an interrupted swap would
  // otherwise block the router forever. Interrupted swaps surface as #needsReview.
  state.busy := false;

  include OrdersApi(state, fees, privacy, rt, orders, active, self);
  include AdminApi(state, fees, privacy, rt, orders, active, self);

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
              ignore await* Engine.step(state, fees, rt, orders, active, self, id);
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
    // Deposit checks run side by side, so with helpers several swaps proceed at once (each
    // claims a free helper; without helpers they queue on the router's lock as before).
    n := 0;
    if (Engine.usableHelpers(rt) > 0) {
      let running = List.empty<async ()>();
      label deposits for (id in ordered.values()) {
        if (n >= Guard.maxPerTick) { break deposits };
        running.add(stepTask(id));
        n += 1;
      };
      for (f in running.values()) { try { await f } catch (_) {} };
    } else {
      // One at a time through the router's own account, as before helpers.
      label deposits for (id in ordered.values()) {
        if (n >= Guard.maxPerTick) { break deposits };
        ignore await* Engine.step(state, fees, rt, orders, active, self, id);
        n += 1;
      };
    };
    await* Engine.sweepOrderFees(state, fees, rt, orders);

    ignore await* Engine.runFeeSweep(state, fees, Engine.feeAutoSweepE8s);
    forgetOldHoudiniIds(now);
  };

  func stepTask(id : Nat) : async () {
    ignore await* Engine.step(state, fees, rt, orders, active, self, id);
  };

  // Walks a few orders per tick; finished orders older than 30 days drop their Houdini id.
  func forgetOldHoudiniIds(now : Int) {
    var seen = 0;
    var last : ?Nat = null;
    label walk for ((id, o) in orders.entriesFrom(privacy.redactCursor)) {
      if (seen >= 25) { break walk };
      seen += 1;
      last := ?id;
      switch (o.status, o.houdiniId) {
        case ((#completed _ or #refunded _), ?_) {
          if (now - o.createdAt > Guard.forgetHoudiniAfterNanos) { o.houdiniId := null };
        };
        case _ {};
      };
    };
    privacy.redactCursor := switch last {
      case (?id) { if (seen < 25) { 0 } else { id + 1 } };
      case null { 0 };
    };
  };

  // Fetch the deposit-account secret right after install/upgrade so the first user doesn't
  // wait for it (createOrder also fetches it if this hasn't run yet).
  transient let _seed : ?Timer.TimerId = if (tickSeconds > 0 and privacy.secret.size() < 24) {
    ?Timer.setTimer<system>(
      #seconds(0),
      func() : async () {
        let r = await Random.blob();
        if (privacy.secret.size() < 24) { privacy.secret := r };
      },
    );
  } else { null };

  transient let _timer : ?Timer.TimerId = if (tickSeconds > 0) {
    ?Timer.recurringTimer<system>(#seconds(tickSeconds), tick);
  } else { null };
};
