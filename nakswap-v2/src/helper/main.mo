// NAKSwap swap helper. Runs one ICPSwap swap at a time for the NAKSwap router, from its own
// account, so the router can run several swaps at once (one per helper) without their
// balances mixing.
//
// A job: pull the order's ICP from the order's deposit account (the router approved this
// helper for exactly that amount), approve the pool, depositFromAndSwap, then send
// everything this helper holds back to the order's deposit account. The router then settles
// the order from that account alone. The helper keeps nothing between jobs.
//
// Only the router can call it (and controllers can upgrade it). No ingress at all.
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
  transient let self = Principal.fromActor(this);

  // Nobody talks to a helper from outside the IC; the router calls it canister-to-canister.
  system func inspect({ arg : Blob }) : Bool { ignore arg; false };

  func icp() : Ext.Ledger = actor (icpLedger.toText());
  func nak() : Ext.Ledger = actor (nakLedger.toText());
  func swapPool() : Ext.SwapPool = actor (pool.toText());
  func now64() : Nat64 { Int.abs(Time.now()).toNat64() };
  func minus(a : Nat, b : Nat) : Nat { if (a <= b) { 0 } else { (a - b : Int).toNat() } };
  let main : Ext.Account = { owner = Principal.fromActor(this); subaccount = null };

  public shared ({ caller }) func swap(job : Ext.HelperJob) : async Ext.HelperResult {
    if (caller != router) { return #notAuthorized };
    if (busy) { return #busy };
    busy := true;
    try { await* run(job) } finally { busy := false };
  };

  public query func routerId() : async Principal { router };

  func run(job : Ext.HelperJob) : async* Ext.HelperResult {
    // 0. Refuse to start while holding anything from an earlier job: those funds belong to
    // another order and must not be mixed into this one.
    let (icp0, nak0) = try {
      (await icp().icrc1_balance_of(main), await nak().icrc1_balance_of(main));
    } catch (_) { return #busy };
    if (icp0 > job.icpFee or nak0 > job.nakFee) { return #dirty({ icp = icp0; nak = nak0 }) };

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
      case (#Err _) { return #done({ pulled = false; nakReturned = 0; icpReturned = 0; note = "could not take the order's ICP"; clean = true }) };
    };

    // 2. Let the pool pull amountIn (+ its transfer_from fee); the approval expires in 5 min.
    var note = "";
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
            case (#ok _) { "" };
            case (#err(#InternalError m)) { m };
            case (#err(#UnsupportedToken m)) { "unsupported token " # m };
            case (#err(#InsufficientFunds)) { "pool: insufficient funds" };
            case (#err(#CommonError)) { "pool: common error" };
          };
        } catch (e) { "pool call rejected: " # e.message() };
      };
    };

    // 4. If the swap failed, ICPSwap may be holding the input (or output) for this helper
    // as "unused balance": pull it out now, while the lock is held, so it goes back to
    // this order and can't surface later in someone else's job.
    var poolLeft = false;
    if (note != "") { poolLeft := not (await* withdrawUnused(job.icpFee, job.nakFee)) };

    // 5. Hand back everything this helper holds.
    let (nakBack, icpBack) = await* returnEverything(job.returnTo, job.nakFee, job.icpFee);
    let clean = (not poolLeft) and (await* holdsNothing(job.icpFee, job.nakFee));
    #done({ pulled = true; nakReturned = nakBack; icpReturned = icpBack; note; clean });
  };

  // True if nothing (beyond fee dust) is left in the pool for this helper afterwards.
  func withdrawUnused(icpFee : Nat, nakFee : Nat) : async* Bool {
    try {
      let (uIcp, uNak) = switch (await swapPool().getUserUnusedBalance(self)) {
        case (#ok b) { if (icpIsToken0) { (b.balance0, b.balance1) } else { (b.balance1, b.balance0) } };
        case (#err _) { return false };
      };
      if (uIcp > icpFee) { ignore await swapPool().withdraw({ token = icpLedger.toText(); fee = icpFee; amount = uIcp }) };
      if (uNak > nakFee) { ignore await swapPool().withdraw({ token = nakLedger.toText(); fee = nakFee; amount = uNak }) };
      switch (await swapPool().getUserUnusedBalance(self)) {
        case (#ok b) { b.balance0 <= Nat.max(icpFee, nakFee) and b.balance1 <= Nat.max(icpFee, nakFee) };
        case (#err _) { false };
      };
    } catch (_) { false };
  };

  func holdsNothing(icpFee : Nat, nakFee : Nat) : async* Bool {
    try {
      (await icp().icrc1_balance_of(main)) <= icpFee and (await nak().icrc1_balance_of(main)) <= nakFee;
    } catch (_) { false };
  };

  func returnEverything(to : Ext.Account, nakFee : Nat, icpFee : Nat) : async* (Nat, Nat) {
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

  // Send whatever this helper holds to `to` (normally the affected order's deposit account).
  public shared ({ caller }) func returnAll(to : Ext.Account, nakFee : Nat, icpFee : Nat) : async { #ok : { nak : Nat; icp : Nat }; #err : Text } {
    if (caller != router) { return #err("not authorized") };
    if (busy) { return #err("helper is busy with a swap") };
    busy := true;
    try {
      // Pool leftovers first, then everything held, in one locked call.
      ignore await* withdrawUnused(icpFee, nakFee);
      let (n, i) = await* returnEverything(to, nakFee, icpFee);
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
