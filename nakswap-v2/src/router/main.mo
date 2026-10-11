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
  let helperOrders = Map.empty<Principal, Nat>();
  let jobFees = Map.empty<Nat, Nat>();
  // Admin dashboard: guardians and audit requests.
  let ops : Types.OpsState = { guardians = Set.empty<Principal>(); audits = Map.empty<Nat, Types.AuditRequest>(); var nextAudit = 0 };
  // Expired orders watched for a late deposit (order -> next check time).
  let lateWatch = Map.empty<Nat, Int>();
  // Finished orders the late-deposit watch reopened (for clearer review messages).
  let revived = Set.empty<Nat>();
  let stats : Types.Stats = { var swaps = 0; var icpSwapped = 0; var nakDelivered = 0; var ready = false };
  // Price reference for the swap price guard. Stable, so an upgrade (done in about a minute)
  // doesn't leave the guard without a reference.
  let priceRef : Types.PriceRef = { var probe = 0; var at = 0 };
  // Automatic payout of the stray account (off until the admin sets a wallet).
  let dustPayout : Types.DustPayout = { var to = null; var minIcp = 12_500_000 };

  transient let self = Principal.fromActor(this);
  transient let rt : Types.Runtime = {
    exec;
    payFromSub;
    subFees;
    inFlight = Set.empty<Nat>();
    busyHelpers = Set.empty<Principal>();
    quarantined;
    helperOrders;
    jobFees;
    lateWatch;
    stats;
    priceRef;
    dustPayout;
    revived;
    var nextHelper = 0;
  };

  // Runs on install and on every upgrade: a lock left set by an interrupted swap would
  // otherwise block the router forever. Interrupted swaps surface as #needsReview.
  state.busy := false;

  // Once, on the upgrade that adds them: totals of the swaps completed so far, and a late-
  // deposit watch for orders that expired before the watch existed.
  if (not stats.ready) {
    for (o in orders.values()) {
      switch (o.status) {
        case (#completed c) {
          stats.swaps += 1;
          stats.icpSwapped += c.icpIn;
          stats.nakDelivered += c.nakOut;
        };
        case (#expired) { Engine.watch(rt, o.id) };
        case _ {};
      };
    };
    stats.ready := true;
  };
  // Once, on the upgrade that extends the late-deposit watch to finished orders.
  let migrations = { var watchFinished = false };
  if (not migrations.watchFinished) {
    for (o in orders.values()) {
      switch (o.status) { case (#completed _ or #refunded _) { Engine.watch(rt, o.id) }; case _ {} };
    };
    migrations.watchFinished := true;
  };

  include OrdersApi(state, fees, privacy, rt, orders, active, self);
  include AdminApi(state, fees, privacy, rt, ops, orders, active, self);

  // Ingress filter, run before a message is accepted, so rejected calls cost the canister
  // nothing. Every update method is for the relay, the admin or a controller; everyone else
  // (and anything oversized) is turned away here. Public queries are unaffected.
  system func inspect({ caller : Principal; arg : Blob }) : Bool {
    arg.size() <= Guard.maxArgBytes and (Orders.isOperator(state.config, caller) or ops.guardians.contains(caller));
  };

  // Background worker. Money already in flight (payouts, refunds) goes first; then a price
  // sample for the swap price guard; then deposit checks, each order at most once a tick and
  // least recently checked first, so a pile of orders can neither starve real ones nor make
  // the router poll the ledger nonstop.
  // tickSeconds = 0 disables it (tests drive the state machine through `poke`).
  transient var tickCount = 0;

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
    if (rt.exec.helpers.size() > 0) {
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
    // Price reference, sampled after this tick's swaps: a swap is always judged against the
    // average of earlier ticks, so a price pushed just before a tick isn't averaged in first.
    // One pool query per tick while orders are open; every few ticks otherwise.
    tickCount += 1;
    if (active.size() > 0 or tickCount % Guard.idleSampleEvery == 0) { await* Engine.samplePrice(state, rt) };

    await* Engine.sweepOrderFees(state, fees, rt, orders);
    await* Engine.autoRecover(state, fees, rt, orders, active, self);
    await* Engine.watchLate(state, rt, orders, active, self, false);
    if (rt.quarantined.size() > 0) { await* Engine.releaseHelpers(state, rt, self) };

    ignore await* Engine.runFeeSweep(state, fees, Engine.feeAutoSweepE8s);
    // Hourly: pay the stray account out once it holds enough (two ledger queries).
    if (tickCount % 60 == 0) { await* Engine.payoutStray(state, rt, self) };
    forgetOldHoudiniIds(now);
  };

  // A swap that finished pays out (or refunds) right away instead of on the next tick.
  func stepTask(id : Nat) : async () {
    switch (await* Engine.step(state, fees, rt, orders, active, self, id)) {
      case (#processed(#payoutPending _ or #refundPending _)) {
        ignore await* Engine.step(state, fees, rt, orders, active, self, id);
      };
      case _ {};
    };
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
