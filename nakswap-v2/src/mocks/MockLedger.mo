// Local stand-in for the ICP ledger and the NAK ledger. Balances are keyed by ICP account
// identifier, like the real ICP ledger, so both ICRC calls (owner + subaccount) and the
// legacy `transfer` (to: account-id blob) that exchanges use land in the same place.
// Implements ICRC-1/2 dedup on (created_at_time, memo) so retry logic can be tested.
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Account "../common/Account";
import Ext "../common/Ext";

actor class MockLedger(symbol : Text, fee : Nat) = this {

  let balances = Map.empty<Blob, Nat>();
  let allowances = Map.empty<Text, Nat>();
  let seen = Map.empty<Text, Nat>();
  var nextBlock = 0;
  // Test hook: make the next N icrc1_transfer calls fail with TemporarilyUnavailable.
  var failTransfers = 0;

  func aid(a : Ext.Account) : Blob = Account.accountId(a.owner, a.subaccount);
  func bal(id : Blob) : Nat = balances.get(id) ?? 0;

  func move(from : Blob, to : Blob, amount : Nat, charge : Nat) : { #ok : Nat; #insufficient : Nat } {
    let have = bal(from);
    if (have < amount + charge) { return #insufficient(have) };
    balances.add(from, (have - amount - charge : Int).toNat());
    balances.add(to, bal(to) + amount);
    let b = nextBlock;
    nextBlock += 1;
    #ok(b);
  };

  func dedupKey(kind : Text, from : Blob, to : Blob, amount : Nat, memo : ?Blob, at : ?Nat64) : ?Text {
    switch at {
      case null { null };
      case (?t) {
        let m = switch memo { case (?x) { Account.toHex(x) }; case null { "" } };
        ?(kind # Account.toHex(from) # Account.toHex(to) # amount.toText() # m # t.toText());
      };
    };
  };

  public query func symbolName() : async Text { symbol };
  public query func icrc1_fee() : async Nat { fee };

  public query func icrc1_balance_of(a : Ext.Account) : async Nat { bal(aid(a)) };

  // Test-only faucet.
  public func mint(to : Ext.Account, amount : Nat) : async Nat {
    balances.add(aid(to), bal(aid(to)) + amount);
    let b = nextBlock;
    nextBlock += 1;
    b;
  };

  public func setFailTransfers(n : Nat) : async () { failTransfers := n };

  public shared ({ caller }) func icrc1_transfer(arg : Ext.TransferArg) : async { #Ok : Nat; #Err : Ext.TransferError } {
    if (failTransfers > 0) {
      failTransfers -= 1;
      return #Err(#TemporarilyUnavailable);
    };
    switch (arg.fee) {
      case (?f) { if (f != fee) { return #Err(#BadFee({ expected_fee = fee })) } };
      case null {};
    };
    let from = aid({ owner = caller; subaccount = arg.from_subaccount });
    let to = aid(arg.to);
    let key = dedupKey("t", from, to, arg.amount, arg.memo, arg.created_at_time);
    switch (key) {
      case (?k) {
        switch (seen.get(k)) {
          case (?b) { return #Err(#Duplicate({ duplicate_of = b })) };
          case null {};
        };
      };
      case null {};
    };
    switch (move(from, to, arg.amount, fee)) {
      case (#ok b) {
        switch key { case (?k) { seen.add(k, b) }; case null {} };
        #Ok(b);
      };
      case (#insufficient have) { #Err(#InsufficientFunds({ balance = have })) };
    };
  };

  public shared ({ caller }) func icrc2_approve(arg : Ext.ApproveArg) : async { #Ok : Nat; #Err : Ext.ApproveError } {
    let owner = aid({ owner = caller; subaccount = arg.from_subaccount });
    if (bal(owner) < fee) { return #Err(#InsufficientFunds({ balance = bal(owner) })) };
    balances.add(owner, (bal(owner) - fee : Int).toNat());
    allowances.add(Account.toHex(owner) # Account.toHex(aid(arg.spender)), arg.amount);
    let b = nextBlock;
    nextBlock += 1;
    #Ok(b);
  };

  public query func icrc2_allowance(arg : { account : Ext.Account; spender : Ext.Account }) : async { allowance : Nat; expires_at : ?Nat64 } {
    { allowance = allowances.get(Account.toHex(aid(arg.account)) # Account.toHex(aid(arg.spender))) ?? 0; expires_at = null };
  };

  public type TransferFromError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #InsufficientAllowance : { allowance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public shared ({ caller }) func icrc2_transfer_from(arg : {
    spender_subaccount : ?Blob;
    from : Ext.Account;
    to : Ext.Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  }) : async { #Ok : Nat; #Err : TransferFromError } {
    let from = aid(arg.from);
    let spender = aid({ owner = caller; subaccount = arg.spender_subaccount });
    let key = Account.toHex(from) # Account.toHex(spender);
    let allowed = allowances.get(key) ?? 0;
    if (allowed < arg.amount + fee) { return #Err(#InsufficientAllowance({ allowance = allowed })) };
    switch (move(from, aid(arg.to), arg.amount, fee)) {
      case (#ok b) {
        allowances.add(key, (allowed - arg.amount - fee : Int).toNat());
        #Ok(b);
      };
      case (#insufficient have) { #Err(#InsufficientFunds({ balance = have })) };
    };
  };

  // Legacy ICP-ledger `transfer` by account identifier: what an exchange paying out ICP uses.
  public type Tokens = { e8s : Nat64 };
  public shared ({ caller }) func transfer(arg : {
    memo : Nat64;
    amount : Tokens;
    fee : Tokens;
    from_subaccount : ?Blob;
    to : Blob;
    created_at_time : ?{ timestamp_nanos : Nat64 };
  }) : async { #Ok : Nat64; #Err : { #InsufficientFunds : { balance : Tokens }; #BadFee : { expected_fee : Tokens } } } {
    if (arg.fee.e8s.toNat() != fee) { return #Err(#BadFee({ expected_fee = { e8s = fee.toNat64() } })) };
    let from = aid({ owner = caller; subaccount = arg.from_subaccount });
    switch (move(from, arg.to, arg.amount.e8s.toNat(), fee)) {
      case (#ok b) { #Ok(b.toNat64()) };
      case (#insufficient have) { #Err(#InsufficientFunds({ balance = { e8s = have.toNat64() } })) };
    };
  };

  public query func accountIdHex(a : Ext.Account) : async Text { Account.toHex(aid(a)) };

  public query func selfId() : async Principal { Principal.fromActor(this) };
};
