// Local stand-in for an ICPSwap SwapPool, ICP -> NAK direction only. Constant-product
// pricing with a 0.3% fee. Behaviour copied from the ICPSwap docs: depositFromAndSwap
// pulls the input with icrc2_transfer_from, and if amountOutMinimum is not met the input
// is sent back to the caller and an error is returned.
import Int "mo:core/Int";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Ext "../common/Ext";

actor class MockSwapPool(icpLedger : Principal, nakLedger : Principal, icpIsToken0 : Bool) = this {

  var icpReserve = 0;
  var nakReserve = 0;
  transient let feeKeep = 997_000; // 0.3% pool fee, per 1e6 like ICPSwap
  // Test hook: make the next swap fail inside the pool after the deposit.
  var breakNextSwap = false;
  // Test hook: the next successful swap also delivers this much extra NAK (a delayed
  // withdraw from an earlier swap landing at the same moment).
  var bonusNextSwap = 0;
  // ICP left in the pool by a failed withdraw, per caller (ICPSwap's "unused balance").
  let unusedIcp = Map.empty<Principal, Nat>();

  type TransferFromArg = {
    spender_subaccount : ?Blob;
    from : Ext.Account;
    to : Ext.Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };
  type IcpLedger = actor {
    icrc2_transfer_from : shared TransferFromArg -> async { #Ok : Nat; #Err : Any };
    icrc1_transfer : shared Ext.TransferArg -> async { #Ok : Nat; #Err : Ext.TransferError };
  };

  func out(amountIn : Nat) : Nat {
    let inAfterFee = amountIn * feeKeep / 1_000_000;
    if (icpReserve + inAfterFee == 0) { return 0 };
    inAfterFee * nakReserve / (icpReserve + inAfterFee);
  };

  // Reserves must be backed by real balances: mint NAK to this pool before seeding.
  public func seed(icp : Nat, nak : Nat) : async () {
    icpReserve := icp;
    nakReserve := nak;
  };

  public func setBreakNextSwap(b : Bool) : async () { breakNextSwap := b };
  public func setBonusNextSwap(n : Nat) : async () { bonusNextSwap := n };

  public query func getUserUnusedBalance(user : Principal) : async { #ok : { balance0 : Nat; balance1 : Nat }; #err : Ext.PoolError } {
    let icp = unusedIcp.get(user) ?? 0;
    #ok(if (icpIsToken0) { { balance0 = icp; balance1 = 0 } } else { { balance0 = 0; balance1 = icp } });
  };

  public shared ({ caller }) func withdraw(args : Ext.WithdrawArgs) : async { #ok : Nat; #err : Ext.PoolError } {
    if (args.token != icpLedger.toText()) { return #err(#UnsupportedToken(args.token)) };
    let have = unusedIcp.get(caller) ?? 0;
    if (args.amount > have or args.amount <= args.fee) { return #err(#InsufficientFunds) };
    unusedIcp.add(caller, (have - args.amount : Int).toNat());
    let icp : IcpLedger = actor (icpLedger.toText());
    switch (
      await icp.icrc1_transfer({
        from_subaccount = null;
        to = { owner = caller; subaccount = null };
        amount = (args.amount - args.fee : Int).toNat();
        fee = ?args.fee;
        memo = null;
        created_at_time = null;
      })
    ) {
      case (#Ok _) { #ok(args.amount) };
      case (#Err _) { #err(#InternalError("transfer failed")) };
    };
  };

  public query func reserves() : async { icp : Nat; nak : Nat } { { icp = icpReserve; nak = nakReserve } };

  public query func quote(args : Ext.SwapArgs) : async { #ok : Nat; #err : Ext.PoolError } {
    if (args.zeroForOne != icpIsToken0) { return #err(#UnsupportedToken("mock only swaps ICP -> NAK")) };
    switch (args.amountIn.toNat()) {
      case (?a) { #ok(out(a)) };
      case null { #err(#InternalError("bad amountIn")) };
    };
  };

  // ICPSwap 3.7.0 pays out (swap output, slippage refunds) from a queue AFTER the call
  // returns. The mock does the same: payouts are queued and paid a few messages later.
  type Payout = { owner : Principal; nakToken : Bool; amount : Nat; fee : Nat; var failed : Bool };
  let queue = Map.empty<Nat, Payout>();
  var nextTx = 0;

  func enqueue(owner : Principal, nakToken : Bool, amount : Nat, fee : Nat, failed : Bool) {
    queue.add(nextTx, { owner; nakToken; amount; fee; var failed });
    nextTx += 1;
  };

  public func noop() : async () {};

  func processSoon() : async () {
    // Let the caller run on for a few messages first, like the real queue's timer.
    await noop();
    await noop();
    await noop();
    await* processQueue();
  };

  func processQueue() : async* () {
    for ((id, p) in queue.entries().toArray().values()) {
      // Still queued (a concurrent run may have paid it already) and not failed.
      if (queue.containsKey(id) and not p.failed) {
        p.failed := true; // in progress: a concurrent run skips it
        let l : Ext.Ledger = actor ((if (p.nakToken) { nakLedger } else { icpLedger }).toText());
        // Like ICPSwap 3.7.0: the transaction is deleted only after the transfer succeeded.
        let r = await l.icrc1_transfer({
          from_subaccount = null;
          to = { owner = p.owner; subaccount = null };
          amount = (p.amount - p.fee : Int).toNat();
          fee = ?p.fee;
          memo = null;
          created_at_time = null;
        });
        switch r { case (#Ok _) { queue.remove(id) }; case (#Err _) {} };
      };
    };
  };

  // Test hook: an ICPSwap admin retries the failed payouts.
  public func retryFailed() : async () {
    for (p in queue.values()) { p.failed := false };
    await* processQueue();
  };

  public query func getTransactionsByOwner(owner : Principal) : async { #ok : [(Nat, Text)]; #err : Ext.PoolError } {
    var out : [(Nat, Text)] = [];
    for ((id, p) in queue.entries()) { if (p.owner == owner) { out := out.concat([(id, "payout")]) } };
    #ok(out);
  };

  public shared ({ caller }) func depositFromAndSwap(args : Ext.DepositAndSwapArgs) : async { #ok : Nat; #err : Ext.PoolError } {
    if (args.zeroForOne != icpIsToken0) { return #err(#UnsupportedToken("mock only swaps ICP -> NAK")) };
    let amountIn = args.amountIn.toNat() ?? (return #err(#InternalError("bad amountIn")));
    let minOut = args.amountOutMinimum.toNat() ?? (return #err(#InternalError("bad amountOutMinimum")));
    let self = Principal.fromActor(this);
    let icp : IcpLedger = actor (icpLedger.toText());

    // Deposit.
    switch (
      await icp.icrc2_transfer_from({
        spender_subaccount = null;
        from = { owner = caller; subaccount = null };
        to = { owner = self; subaccount = null };
        amount = amountIn;
        fee = ?args.tokenInFee;
        memo = null;
        created_at_time = null;
      })
    ) {
      case (#Ok _) {};
      case (#Err _) { return #err(#InternalError("deposit failed")) };
    };

    let amountOut = out(amountIn);
    if (amountOut < minOut) {
      // Refunded later, minus the transfer fee.
      enqueue(caller, false, amountIn, args.tokenInFee, false);
      ignore processSoon();
      return #err(#InternalError("Slippage check failed: " # amountOut.toText() # " < " # minOut.toText()));
    };

    icpReserve += amountIn;
    nakReserve := (nakReserve - amountOut : Int).toNat();
    // The output is paid later; with the test hook the payout fails and waits for an admin.
    let failed = breakNextSwap;
    breakNextSwap := false;
    enqueue(caller, true, amountOut + bonusNextSwap, args.tokenOutFee, failed);
    bonusNextSwap := 0;
    ignore processSoon();
    #ok(amountOut);
  };
};
