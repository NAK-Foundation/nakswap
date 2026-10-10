import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
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
  rt : Types.Runtime,
  ops : Types.OpsState,
  orders : Map.Map<Nat, Types.Order>,
  active : Set.Set<Nat>,
  self : Principal,
) {

  public query func getConfig() : async Types.Config { state.config };

  // ---- admin dashboard (guardians) ----

  func isGuardian(caller : Principal) : Bool {
    Orders.isAdmin(state.config, caller) or ops.guardians.contains(caller);
  };
  func canWatch(caller : Principal) : Bool {
    Orders.isOperator(state.config, caller) or ops.guardians.contains(caller);
  };

  public query ({ caller }) func myRole() : async Types.Role {
    if (caller.isController()) { #controller } else if (caller == state.config.admin) { #admin } else if (ops.guardians.contains(caller)) {
      #guardian;
    } else if (Orders.isOperator(state.config, caller)) { #operator } else { #none };
  };

  // Controllers only. A guardian can watch, freeze/unfreeze, run recovery and request
  // audits, but can't move funds or change settings.
  public shared ({ caller }) func addGuardian(p : Principal) : async Bool {
    if (not caller.isController()) { return false };
    if (p.isAnonymous() or p == self or ops.guardians.size() >= 5) { return false };
    ops.guardians.add(p);
    true;
  };

  public shared ({ caller }) func removeGuardian(p : Principal) : async Bool {
    if (not caller.isController()) { return false };
    ops.guardians.remove(p);
    true;
  };

  public query ({ caller }) func guardians() : async [Principal] {
    if (not isGuardian(caller)) { return [] };
    ops.guardians.values().toArray();
  };

  // A guardian asks for a security audit. Public list (ids, times, notes) so the scheduled
  // audit can pick requests up without any key; at most one per 10 minutes, last 50 kept.
  public shared ({ caller }) func requestAudit(note : Text) : async ?Nat {
    if (not isGuardian(caller)) { return null };
    if (note.size() > 280) { return null };
    let now = Time.now();
    if (ops.nextAudit > 0) {
      switch (ops.audits.get((ops.nextAudit - 1 : Int).toNat())) {
        case (?last) { if (now - last.at < 600_000_000_000) { return null } };
        case null {};
      };
    };
    let id = ops.nextAudit;
    ops.audits.add(id, { id; at = now; by = caller; note });
    ops.nextAudit += 1;
    if (id >= 50) { ops.audits.remove((id - 50 : Int).toNat()) };
    ?id;
  };

  // Counts only, no identities or amounts: lets an outside monitor (the scheduled audit) see
  // trouble without holding any key.
  public query func publicStatus() : async {
    paused : Bool;
    acceptingOrders : Bool;
    cycles : Nat;
    openOrders : Nat;
    maxOpenOrders : Nat;
    needsReview : Nat;
    helpers : Nat;
    quarantinedHelpers : Nat;
    ordersWithHelperFunds : Nat;
    stuckFees : Nat;
    ordersLastHour : Nat;
  } {
    var review = 0;
    var lastHour = 0;
    let hourAgo = Time.now() - 3_600_000_000_000;
    for (o in orders.values()) {
      switch (o.status) { case (#needsReview _) { review += 1 }; case _ {} };
      if (o.createdAt >= hourAgo) { lastHour += 1 };
    };
    let cycles = Cycles.balance();
    {
      paused = state.config.paused;
      acceptingOrders = not state.config.paused and cycles >= Guard.lowCycles;
      cycles;
      openOrders = active.size();
      maxOpenOrders = Guard.maxOpenOrders;
      needsReview = review;
      helpers = rt.exec.helpers.size();
      quarantinedHelpers = rt.quarantined.size();
      ordersWithHelperFunds = rt.jobFees.size();
      stuckFees = fees.stuck;
      ordersLastHour = lastHour;
    };
  };

  public query func auditRequests() : async [{ id : Nat; at : Int; note : Text }] {
    ops.audits.values().map(func(a : Types.AuditRequest) : { id : Nat; at : Int; note : Text } = { id = a.id; at = a.at; note = a.note }).toArray();
  };

  func statusTag(s : Types.Status) : Text {
    switch s {
      case (#awaitingDeposit) { "awaitingDeposit" };
      case (#swapping _) { "swapping" };
      case (#payoutPending _) { "payoutPending" };
      case (#refundPending _) { "refundPending" };
      case (#completed _) { "completed" };
      case (#refunded _) { "refunded" };
      case (#expired) { "expired" };
      case (#needsReview _) { "needsReview" };
    };
  };

  func line(o : Types.Order) : Types.OrderLine {
    let (icpIn, nakOut, detail) = switch (o.status) {
      case (#completed c) { (c.icpIn, c.nakOut, "") };
      case (#payoutPending p) { (p.icpIn, p.nakAmount, "") };
      case (#swapping s) { (s.icpIn, 0, "") };
      case (#refunded r) { (r.icpAmount, 0, debug_show r.reason) };
      case (#refundPending r) { (r.icpAmount, 0, debug_show r.reason) };
      case (#needsReview m) { (0, 0, m) };
      case _ { (0, 0, "") };
    };
    { id = o.id; status = statusTag(o.status); createdAt = o.createdAt; icpIn; nakOut; detail };
  };

  // Everything the dashboard shows, in one call.
  public query ({ caller }) func adminOverview() : async ?Types.Overview {
    if (not canWatch(caller)) { return null };
    let tags = ["awaitingDeposit", "swapping", "payoutPending", "refundPending", "completed", "refunded", "expired", "needsReview"];
    let counts = Map.empty<Text, Nat>();
    let review = List.empty<Types.OrderLine>();
    var lastHour = 0;
    let hourAgo = Time.now() - 3_600_000_000_000;
    for (o in orders.values()) {
      let t = statusTag(o.status);
      counts.add(t, (counts.get(t) ?? 0) + 1);
      if (t == "needsReview" and review.size() < 50) { review.add(line(o)) };
      if (o.createdAt >= hourAgo) { lastHour += 1 };
    };
    let recent = List.empty<Types.OrderLine>();
    for ((_, o) in orders.reverseEntries()) {
      if (recent.size() >= 30) { break };
      recent.add(line(o));
    };
    let cycles = Cycles.balance();
    ?{
      health = {
        cycles;
        lowCyclesThreshold = Guard.lowCycles;
        acceptingOrders = not state.config.paused and cycles >= Guard.lowCycles;
        paused = state.config.paused;
        activeOrders = active.size();
        nextOrderId = state.nextId;
        feeBps = fees.bps;
        helpers = rt.exec.helpers.size();
      };
      maxOpenOrders = Guard.maxOpenOrders;
      counts = tags.map<Text, (Text, Nat)>(func t = (t, counts.get(t) ?? 0));
      ordersLastHour = lastHour;
      review = review.toArray();
      recent = recent.toArray();
      helpers = rt.exec.helpers.map(func(h : Principal) : Types.HelperInfo = { helper = h; busy = rt.busyHelpers.contains(h); quarantined = rt.quarantined.contains(h); holdsOrder = rt.helperOrders.get(h) });
      fees = {
        bps = fees.bps;
        to = fees.to;
        accrued = fees.accrued + rt.subFees.values().foldLeft(0, func(acc : Nat, f : Types.SubFee) : Nat = acc + f.amount);
        paidTotal = fees.paidTotal;
        stuck = fees.stuck;
        pending = fees.pending;
        autoSweepAt = Engine.feeAutoSweepE8s;
      };
      ordersWithHelperFunds = rt.jobFees.size();
      straySubaccount = Account.straySubaccount;
    };
  };

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
    if (not isGuardian(caller)) { return false };
    state.config := { state.config with paused };
    true;
  };

  // Put an expired / needs-review order back in the queue, e.g. Houdini paid after the TTL.
  public shared ({ caller }) func reopen(id : Nat) : async ?Types.Status {
    if (not Orders.isAdmin(state.config, caller)) { return null };
    switch (orders.get(id)) {
      case (?o) {
        switch (o.status) {
          case (#needsReview r) {
            // A payout may already have gone out: check the NAK ledger and use forcePayout
            // (or nothing) instead of starting over.
            if (not r.startsWith(#text "payout") and not rt.inFlight.contains(id)) {
              rt.payFromSub.remove(id);
              rt.subFees.remove(id);
              Engine.setStatus(o, active, #awaitingDeposit);
            };
          };
          case (#expired) { Engine.setStatus(o, active, #awaitingDeposit) };
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
    if (not refundable(o.status) or rt.inFlight.contains(id)) { return ?o.status };
    let ledger : Ext.Ledger = actor (cfg.icpLedger.toText());
    if (fromDeposit) {
      let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = ?o.subaccount });
      if (icpAmount + cfg.icpFee > bal) { return ?o.status };
      // NAK in there means the swap went through: pay it out (forcePayout), don't refund.
      let nakL : Ext.Ledger = actor (cfg.nakLedger.toText());
      if ((await nakL.icrc1_balance_of({ owner = self; subaccount = ?o.subaccount })) > cfg.nakFee) { return ?o.status };
    } else {
      if (state.busy) { return ?o.status };
      let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = null });
      if (icpAmount + cfg.icpFee + fees.accrued > bal or state.busy) { return ?o.status };
    };
    if (not refundable(o.status) or rt.inFlight.contains(id)) { return ?o.status }; // re-check after the await
    if (fromDeposit) { rt.subFees.remove(id) }; // whatever is refunded from there is the user's
    rt.payFromSub.remove(id);
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
  // `fromDeposit`: pay from the order's own deposit account (helper path: the helper
  // returns NAK there) instead of the router's main account.
  public shared ({ caller }) func forcePayout(id : Nat, nakAmount : Nat, fromDeposit : Bool) : async ?Types.Status {
    if (not Orders.isAdmin(state.config, caller)) { return null };
    let cfg = state.config;
    if (nakAmount == 0) { return null };
    let o = switch (orders.get(id)) { case (?o) { o }; case null { return null } };
    switch (o.status) { case (#needsReview _) {}; case _ { return ?o.status } };
    if (rt.inFlight.contains(id) or (not fromDeposit and state.busy)) { return ?o.status };
    let ledger : Ext.Ledger = actor (cfg.nakLedger.toText());
    let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = if fromDeposit { ?o.subaccount } else { null } });
    if (nakAmount + cfg.nakFee > bal or rt.inFlight.contains(id) or (not fromDeposit and state.busy)) { return ?o.status };
    switch (o.status) { case (#needsReview _) {}; case _ { return ?o.status } };
    if (fromDeposit) { rt.payFromSub.add(id) } else { rt.payFromSub.remove(id) };
    Engine.setStatus(o, active, #payoutPending({ icpIn = 0; nakAmount; createdAtTime = Int.abs(Time.now()).toNat64() }));
    ?o.status;
  };

  // ---- swap helpers ----

  // Replace the helper list (empty = swap from the router's main account as before).
  // Refused while any helper is working.
  // Controllers only (helpers get allowances on every deposit). Each helper must be a NAKSwap
  // helper built for this router (it reports this router's id) and must have exactly the
  // same controllers as the router, so a typo or a stranger's canister can't be slipped in.
  // `moduleHash`: sha256 of the helper wasm (build/helper.wasm); every helper must run exactly
  // that code. A quarantined helper can't be dropped from the list until it's cleared.
  public shared ({ caller }) func setHelpers(list : [Principal], moduleHash : Blob) : async Bool {
    if (not caller.isController()) { return false };
    if (rt.busyHelpers.size() > 0 or list.size() > 5) { return false };
    for (q in rt.quarantined.values()) {
      if (not list.any(func(p : Principal) : Bool = p == q)) { return false };
    };
    let cfg = state.config;
    for (p in list.values()) {
      if (
        p.isAnonymous() or p == self or p == cfg.pool or p == cfg.icpLedger or p == cfg.nakLedger
        or p == cfg.admin or p == fees.to or cfg.operators.any(func(o : Principal) : Bool = o == p)
      ) { return false };
    };
    let seen = Set.empty<Principal>();
    for (p in list.values()) { if (seen.contains(p)) { return false }; seen.add(p) };
    if (not (await* verifyHelpers(list, moduleHash))) { return false };
    if (rt.busyHelpers.size() > 0) { return false }; // re-check after the awaits
    rt.exec.helpers := list;
    rt.nextHelper := 0;
    true;
  };

  type CanisterInfo = actor {
    canister_info : shared { canister_id : Principal; num_requested_changes : ?Nat64 } -> async {
      total_num_changes : Nat64;
      recent_changes : [Any];
      module_hash : ?Blob;
      controllers : [Principal];
    };
  };

  func verifyHelpers(list : [Principal], moduleHash : Blob) : async* Bool {
    let ic : CanisterInfo = actor ("aaaaa-aa");
    try {
      let mine = Set.fromIter<Principal>((await ic.canister_info({ canister_id = self; num_requested_changes = null })).controllers.values(), Principal.compare);
      for (p in list.values()) {
        let h : Ext.Helper = actor (p.toText());
        if ((await h.routerId()) != self) { return false };
        let info = await ic.canister_info({ canister_id = p; num_requested_changes = null });
        if (info.module_hash != ?moduleHash) { return false };
        if (info.controllers.size() != mine.size()) { return false };
        for (c in info.controllers.values()) { if (not mine.contains(c)) { return false } };
      };
      true;
    } catch (_) { false };
  };

  // Put a quarantined helper back into rotation, after its funds were returned
  // (helperRecover) and the affected orders resolved.
  // Only once the helper is empty and ICPSwap has nothing pending or failed for it.
  public shared ({ caller }) func clearHelper(i : Nat) : async Bool {
    if (not Orders.isAdmin(state.config, caller)) { return false };
    let h = switch (helperAt(i)) { case (?h) { h }; case null { return false } };
    if (rt.busyHelpers.contains(h)) { return false };
    let a : Ext.Helper = actor (h.toText());
    let ok = try { await a.settled(state.config.icpFee, state.config.nakFee) } catch (_) { false };
    if (ok) {
      rt.quarantined.remove(h);
      rt.helperOrders.remove(h);
    };
    ok;
  };

  // Run the background recovery of parked helpers now (it also runs on every tick).
  public shared ({ caller }) func runRecovery() : async () {
    if (not isGuardian(caller)) { return };
    await* Engine.autoRecover(state, fees, rt, orders, active, self);
  };

  // Funds a stranger sent to a helper, set aside by the helper in the router's stray account.
  public shared ({ caller }) func recoverStray(to : Principal) : async Result.Result<{ icp : Nat; nak : Nat }, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    if (to.isAnonymous() or to == self) { return #err("bad destination") };
    let cfg = state.config;
    let acct = { owner = self; subaccount = ?Account.straySubaccount };
    var sent = { icp = 0; nak = 0 };
    for ((isIcp, l, f) in [(true, cfg.icpLedger, cfg.icpFee), (false, cfg.nakLedger, cfg.nakFee)].values()) {
      let ledger : Ext.Ledger = actor (l.toText());
      let bal = await ledger.icrc1_balance_of(acct);
      if (bal > f) {
        switch (await ledger.icrc1_transfer({ from_subaccount = ?Account.straySubaccount; to = { owner = to; subaccount = null }; amount = bal - f; fee = ?f; memo = null; created_at_time = null })) {
          case (#Ok _) { sent := if isIcp { { sent with icp = bal - f } } else { { sent with nak = bal - f } } };
          case (#Err _) {};
        };
      };
    };
    #ok(sent);
  };

  public query ({ caller }) func helpers() : async [Types.HelperInfo] {
    if (not canWatch(caller)) { return [] };
    rt.exec.helpers.map(func(h : Principal) : Types.HelperInfo = { helper = h; busy = rt.busyHelpers.contains(h); quarantined = rt.quarantined.contains(h); holdsOrder = rt.helperOrders.get(h) });
  };

  func helperAt(i : Nat) : ?Principal {
    if (i < rt.exec.helpers.size()) { ?rt.exec.helpers[i] } else { null };
  };

  // What ICPSwap holds for helper `i` as unused balance.
  public shared ({ caller }) func helperPoolUnused(i : Nat) : async Result.Result<{ icp : Nat; nak : Nat }, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    let h = switch (helperAt(i)) { case (?h) { h }; case null { return #err("no such helper") } };
    let a : Ext.Helper = actor (h.toText());
    await a.poolUnused();
  };

  // Helper `i` pulls its unused balance out of the pool (into the helper's own account; then
  // use helperReturnAll to send it to the order it belongs to).
  public shared ({ caller }) func helperWithdrawFromPool(i : Nat, icpToken : Bool, amount : Nat) : async Result.Result<Nat, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    let h = switch (helperAt(i)) { case (?h) { h }; case null { return #err("no such helper") } };
    if (rt.busyHelpers.contains(h)) { return #err("helper is busy; try again in a minute") };
    rt.busyHelpers.add(h);
    let cfg = state.config;
    try {
      let a : Ext.Helper = actor (h.toText());
      await a.withdrawFromPool(icpToken, amount, if icpToken { cfg.icpFee } else { cfg.nakFee });
    } catch (e) { #err(e.message()) } finally { rt.busyHelpers.remove(h) };
  };

  // Helper `i` pulls anything ICPSwap holds for it and sends everything it holds to order
  // `id`'s deposit account (then resolve with forcePayout / forceRefund, fromDeposit = true),
  // or, with no order, to the router's stray account (recoverStray).
  public shared ({ caller }) func helperRecover(i : Nat, id : ?Nat) : async Result.Result<{ icp : Nat; nak : Nat }, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    let h = switch (helperAt(i)) { case (?h) { h }; case null { return #err("no such helper") } };
    let to : Ext.Account = switch id {
      case (?oid) {
        let o = switch (orders.get(oid)) { case (?o) { o }; case null { return #err("no such order") } };
        if (rt.inFlight.contains(oid)) { return #err("order is busy; try again in a minute") };
        switch (o.status) { case (#needsReview _) {}; case _ { return #err("order is not in needs review") } };
        { owner = self; subaccount = ?o.subaccount };
      };
      case null { { owner = self; subaccount = ?Account.straySubaccount } };
    };
    if (rt.busyHelpers.contains(h)) { return #err("helper is busy; try again in a minute") };
    rt.busyHelpers.add(h);
    switch id { case (?oid) { rt.inFlight.add(oid) }; case null {} };
    let cfg = state.config;
    try {
      let a : Ext.Helper = actor (h.toText());
      let r = await a.returnAll(to, cfg.nakFee, cfg.icpFee);
      switch r { case (#ok _) { rt.helperOrders.remove(h) }; case (#err _) {} };
      r;
    } catch (e) { #err(e.message()) } finally {
      rt.busyHelpers.remove(h);
      switch id { case (?oid) { rt.inFlight.remove(oid) }; case null {} };
    };
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
    if (not canWatch(caller)) { return [] };
    let out = Map.empty<Nat, Types.OrderView>();
    for ((id, o) in orders.entriesFrom(fromId)) {
      if (out.size() >= Nat.min(limit, 100)) { break };
      out.add(id, o.toView());
    };
    out.values().toArray();
  };

  public query ({ caller }) func activeOrderIds() : async [Nat] {
    if (not canWatch(caller)) { return [] };
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
      helpers = rt.exec.helpers.size();
    };
  };

  // ICP that landed in a deposit account with no order to handle it (an order that was
  // never paired with Houdini and got cleaned up, or one already finished). Sends the whole
  // balance, minus the ledger fee, to `to`.
  public shared ({ caller }) func recoverDeposit(id : Nat, to : Principal) : async Result.Result<{ icp : Nat; nak : Nat }, Text> {
    if (not Orders.isAdmin(state.config, caller)) { return #err("not authorized") };
    if (to.isAnonymous() or to == self) { return #err("bad destination") };
    let sub = switch (orders.get(id)) {
      case null {
        if (privacy.secret.size() < 24 or id >= state.nextId) { return #err("no such order") };
        Account.depositSubaccount(self, privacy.secret, id);
      };
      case (?o) {
        if (rt.inFlight.contains(id)) { return #err("order is being processed right now") };
        switch (o.status) {
          case (#completed _ or #refunded _ or #expired or #needsReview _) {
            rt.subFees.remove(id); // anything still in there leaves with this recovery
            o.subaccount;
          };
          case _ { return #err("order is still being processed") };
        };
      };
    };
    let cfg = state.config;
    rt.inFlight.add(id);
    var sent = { icp = 0; nak = 0 };
    try {
      // ICP and NAK (e.g. a partial fill's leftover ICP, or NAK left after a refund).
      for ((isIcp, l, f) in [(true, cfg.icpLedger, cfg.icpFee), (false, cfg.nakLedger, cfg.nakFee)].values()) {
        let ledger : Ext.Ledger = actor (l.toText());
        let bal = await ledger.icrc1_balance_of({ owner = self; subaccount = ?sub });
        if (bal > f) {
          switch (await ledger.icrc1_transfer({ from_subaccount = ?sub; to = { owner = to; subaccount = null }; amount = bal - f; fee = ?f; memo = null; created_at_time = null })) {
            case (#Ok _) { sent := if isIcp { { sent with icp = bal - f } } else { { sent with nak = bal - f } } };
            case (#Err _) {};
          };
        };
      };
    } finally { rt.inFlight.remove(id) };
    if (sent.icp == 0 and sent.nak == 0) { #err("nothing to recover") } else { #ok(sent) };
  };

  // ---- NAKSwap fee ----
  public query func feeStatus() : async Types.FeeStatus {
    {
      bps = fees.bps;
      to = fees.to;
      // Earned and not yet sent: in the router's main account plus in finished orders'
      // deposit accounts (helper path).
      accrued = fees.accrued + rt.subFees.values().foldLeft(0, func(acc : Nat, f : Types.SubFee) : Nat = acc + f.amount);
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
    let before = fees.paidTotal;
    ignore await* Engine.runFeeSweep(state, fees, 2 * state.config.icpFee);
    await* Engine.sweepOrderFees(state, fees, rt, orders);
    Engine.minus(fees.paidTotal, before);
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
