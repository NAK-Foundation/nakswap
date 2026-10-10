// NAKSwap swap helper. Runs one ICPSwap swap at a time for the NAKSwap router, from its own
// account, so the router can run several swaps at once (one per helper) without their
// balances mixing.
//
// A job: pull the order's ICP from the order's deposit account (the router approved this
// helper for exactly that amount), approve the pool, depositFromAndSwap, WAIT until ICPSwap
// has finished paying out (it pays swap output and refunds from a queue after its call
// returns), then send everything this helper holds back to the order's deposit account.
// The helper keeps nothing between jobs. If ICPSwap hasn't finished within the wait, the
// helper keeps what it has and reports `clean = false`; the router takes it out of rotation
// until an admin recovers those funds to the right order.
//
// Only the router can call it (and controllers can upgrade it). No ingress at all.
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Ext "../common/Ext";

actor class Helper(router : Principal, icpLedger : Principal, nakLedger : Principal, pool : Principal, icpIsToken0 : Bool) = this {

  // One job at a time. Transient: an upgrade (done with the canister stopped, so no job is
  // in flight) starts unlocked.
  transient var busy = false;
  // Did the last job finish with ICPSwap settled and everything returned? If so, anything
  // found in this helper at the start of a job was sent by someone else (stray) and can be
  // moved aside safely. If not, it may be a late payout of the last job: refuse work.
  var lastClean = true;
  transient let self = Principal.fromActor(this);

  // How long to wait for ICPSwap's payout queue: rounds of one pool query each.
  transient let maxWaitRounds = 150;

  // Nobody talks to a helper from outside the IC; the router calls it canister-to-canister.
  system func inspect({ arg : Blob }) : Bool { ignore arg; false };

  func icp() : Ext.Ledger = actor (icpLedger.toText());
  func nak() : Ext.Ledger = actor (nakLedger.toText());
  func swapPool() : Ext.SwapPool = actor (pool.toText());
  func now64() : Nat64 { Int.abs(Time.now()).toNat64() };
  func minus(a : Nat, b : Nat) : Nat { if (a <= b) { 0 } else { (a - b : Int).toNat() } };
  let main : Ext.Account = { owner = Principal.fromActor(this); subaccount = null };

  public query func routerId() : async Principal { router };

  // For the admin dashboard and monitoring.
  public query func health() : async { cycles : Nat; busy : Bool; lastClean : Bool } {
    { cycles = Cycles.balance(); busy; lastClean };
  };

  public shared ({ caller }) func swap(job : Ext.HelperJob) : async Ext.HelperResult {
    if (caller != router) { return #notAuthorized };
    if (busy) { return #busy };
    busy := true;
    try { await* run(job) } finally { busy := false };
  };

  // ICPSwap has nothing pending or failed for this helper and holds no unused balance.
  func poolSettled(icpFee : Nat, nakFee : Nat) : async* Bool {
    try {
      let pending = switch (await swapPool().getTransactionsByOwner(self)) {
        case (#ok txs) { txs.size() };
        case (#err _) { return false };
      };
      if (pending > 0) { return false };
      switch (await swapPool().getUserUnusedBalance(self)) {
        case (#ok b) {
          let (uIcp, uNak) = if (icpIsToken0) { (b.balance0, b.balance1) } else { (b.balance1, b.balance0) };
          uIcp <= icpFee and uNak <= nakFee;
        };
        case (#err _) { false };
      };
    } catch (_) { false };
  };

  func waitForPool(icpFee : Nat, nakFee : Nat) : async* Bool {
    var round = 0;
    while (round < maxWaitRounds) {
      if (await* poolSettled(icpFee, nakFee)) { return true };
      round += 1;
    };
    false;
  };

  func balances() : async* ?(Nat, Nat) {
    try { ?(await icp().icrc1_balance_of(main), await nak().icrc1_balance_of(main)) } catch (_) { null };
  };

  func run(job : Ext.HelperJob) : async* Ext.HelperResult {
    // 0. Start clean. Anything held now is either a late payout of the last job (refuse) or
    // something a stranger sent (move it aside to the router's stray account, then go on).
    let (icp0, nak0) = switch (await* balances()) { case (?b) { b }; case null { return #busy } };
    if (not lastClean) { return #dirty({ icp = icp0; nak = nak0 }) };
    if (not (await* poolSettled(job.icpFee, job.nakFee))) {
      lastClean := false;
      return #dirty({ icp = icp0; nak = nak0 });
    };
    if (icp0 > job.icpFee or nak0 > job.nakFee) {
      ignore await* sendAll(job.strayTo, job.nakFee, job.icpFee);
      switch (await* balances()) {
        case (?(i, n)) { if (i > job.icpFee or n > job.nakFee) { return #dirty({ icp = i; nak = n }) } };
        case null { return #busy };
      };
    };

    // 1. Take the job's ICP. If this fails nothing moved and the router simply retries.
    let pulled = try {
      await icp().icrc2_transfer_from({
        spender_subaccount = null;
        from = job.from;
        to = main;
        amount = job.pull;
        fee = ?job.icpFee;
        memo = null;
        created_at_time = null;
      });
    } catch (e) { #Err(#GenericError({ error_code = 0; message = e.message() })) };
    switch pulled {
      case (#Ok _) {};
      case (#Err _) {
        return #done({ pulled = false; swapped = false; nakReturned = 0; icpReturned = 0; note = "could not take the order's ICP"; clean = true });
      };
    };
    // From here until everything is handed back, this helper holds the order's funds.
    lastClean := false;

    // 2. Let the pool pull amountIn (+ its transfer_from fee); the approval expires in 5 min.
    var note = "";
    var swapped = false;
    let approved = try {
      await icp().icrc2_approve({
        from_subaccount = null;
        spender = { owner = pool; subaccount = null };
        amount = job.amountIn + job.icpFee;
        expected_allowance = null;
        expires_at = ?(now64() + 300_000_000_000);
        fee = ?job.icpFee;
        memo = null;
        created_at_time = null;
      });
    } catch (e) { #Err(#GenericError({ error_code = 0; message = e.message() })) };

    // 3. Swap.
    switch approved {
      case (#Err _) { note := "approve failed" };
      case (#Ok _) {
        note := try {
          switch (
            await swapPool().depositFromAndSwap({
              amountIn = job.amountIn.toText();
              zeroForOne = job.zeroForOne;
              amountOutMinimum = job.minOut.toText();
              tokenInFee = job.icpFee;
              tokenOutFee = job.nakFee;
            })
          ) {
            case (#ok _) { swapped := true; "" };
            case (#err(#InternalError m)) { m };
            case (#err(#UnsupportedToken m)) { "unsupported token " # m };
            case (#err(#InsufficientFunds)) { "pool: insufficient funds" };
            case (#err(#CommonError)) { "pool: common error" };
          };
        } catch (e) { "pool call rejected: " # e.message() };
      };
    };

    // 4. ICPSwap pays the NAK (or refunds the ICP) after its call returns: wait for it.
    if (not (await* waitForPool(job.icpFee, job.nakFee))) {
      // Not done yet (or a payout failed on ICPSwap's side). Keep everything together here
      // so it can't be split between orders; the router parks the order for an admin.
      return #done({ pulled = true; swapped; nakReturned = 0; icpReturned = 0; note = "ICPSwap has not finished paying out" # (if (note == "") { "" } else { ": " # note }); clean = false });
    };

    // 5. Hand back everything this helper holds.
    let (nakBack, icpBack) = await* sendAll(job.returnTo, job.nakFee, job.icpFee);
    let empty = switch (await* balances()) {
      case (?(i, n)) { i <= job.icpFee and n <= job.nakFee };
      case null { false };
    };
    // What came back must match what happened: NAK after a swap, ICP after a failed one.
    // Anything else means a payout may still be on its way: stay dirty.
    let consistent = if swapped { nakBack > job.nakFee } else { icpBack > 0 };
    let clean = empty and consistent;
    if (clean) { lastClean := true };
    #done({ pulled = true; swapped; nakReturned = nakBack; icpReturned = icpBack; note; clean });
  };

  func sendAll(to : Ext.Account, nakFee : Nat, icpFee : Nat) : async* (Nat, Nat) {
    var nakSent = 0;
    var icpSent = 0;
    try {
      let n = await nak().icrc1_balance_of(main);
      if (n > nakFee) {
        switch (await nak().icrc1_transfer({ from_subaccount = null; to; amount = minus(n, nakFee); fee = ?nakFee; memo = null; created_at_time = null })) {
          case (#Ok _) { nakSent := minus(n, nakFee) };
          case (#Err _) {};
        };
      };
    } catch (_) {};
    try {
      let i = await icp().icrc1_balance_of(main);
      if (i > icpFee) {
        switch (await icp().icrc1_transfer({ from_subaccount = null; to; amount = minus(i, icpFee); fee = ?icpFee; memo = null; created_at_time = null })) {
          case (#Ok _) { icpSent := minus(i, icpFee) };
          case (#Err _) {};
        };
      };
    } catch (_) {};
    (nakSent, icpSent);
  };

  // ---- recovery, router only (the router exposes these to its admin) ----

  // Is this helper empty and ICPSwap done with it? If so it's safe to use again.
  public shared ({ caller }) func settled(icpFee : Nat, nakFee : Nat) : async Bool {
    if (caller != router) { return false };
    if (busy) { return false };
    let ok = (await* poolSettled(icpFee, nakFee)) and (switch (await* balances()) { case (?(i, n)) { i <= icpFee and n <= nakFee }; case null { false } });
    if (ok) { lastClean := true };
    ok;
  };

  // Send whatever this helper holds to `to` (normally the affected order's deposit account),
  // once ICPSwap has finished with it.
  public shared ({ caller }) func returnAll(to : Ext.Account, nakFee : Nat, icpFee : Nat) : async { #ok : { nak : Nat; icp : Nat }; #err : Text } {
    if (caller != router) { return #err("not authorized") };
    if (busy) { return #err("helper is busy with a swap") };
    busy := true;
    try {
      if (not (await* poolSettled(icpFee, nakFee))) { return #err("ICPSwap still has pending or failed transactions for this helper") };
      let (n, i) = await* sendAll(to, nakFee, icpFee);
      switch (await* balances()) {
        case (?(bi, bn)) { if (bi <= icpFee and bn <= nakFee) { lastClean := true } };
        case null {};
      };
      #ok({ nak = n; icp = i });
    } finally { busy := false };
  };

  public shared ({ caller }) func poolUnused() : async { #ok : { icp : Nat; nak : Nat }; #err : Text } {
    if (caller != router) { return #err("not authorized") };
    try {
      switch (await swapPool().getUserUnusedBalance(self)) {
        case (#ok b) {
          #ok(if (icpIsToken0) { { icp = b.balance0; nak = b.balance1 } } else { { icp = b.balance1; nak = b.balance0 } });
        };
        case (#err _) { #err("pool returned an error") };
      };
    } catch (e) { #err(e.message()) };
  };

  public shared ({ caller }) func withdrawFromPool(icpToken : Bool, amount : Nat, fee : Nat) : async { #ok : Nat; #err : Text } {
    if (caller != router) { return #err("not authorized") };
    if (busy) { return #err("helper is busy with a swap") };
    busy := true;
    try {
      switch (
        await swapPool().withdraw({
          token = (if icpToken { icpLedger } else { nakLedger }).toText();
          fee;
          amount;
        })
      ) {
        case (#ok n) { #ok(n) };
        case (#err(#InternalError m)) { #err(m) };
        case (#err _) { #err("pool refused the withdraw") };
      };
    } catch (e) {
      #err(e.message());
    } finally { busy := false };
  };
};
