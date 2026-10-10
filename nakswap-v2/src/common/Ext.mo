// Interfaces of the canisters NAKSwap v2 talks to.
// These mirror the mainnet Candid exactly: Candid variants must list every tag the
// remote side can return, or decoding a reply fails.
module {

  // ---------- ICRC-1 / ICRC-2 ledger (ICP ledger and NAK ledger) ----------

  public type Account = { owner : Principal; subaccount : ?Blob };

  public type TransferArg = {
    from_subaccount : ?Blob;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type ApproveArg = {
    from_subaccount : ?Blob;
    spender : Account;
    amount : Nat;
    expected_allowance : ?Nat;
    expires_at : ?Nat64;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type ApproveError = {
    #BadFee : { expected_fee : Nat };
    #InsufficientFunds : { balance : Nat };
    #AllowanceChanged : { current_allowance : Nat };
    #Expired : { ledger_time : Nat64 };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type TransferFromArg = {
    spender_subaccount : ?Blob;
    from : Account;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
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

  public type Ledger = actor {
    icrc1_balance_of : shared query (Account) -> async Nat;
    icrc1_transfer : shared (TransferArg) -> async { #Ok : Nat; #Err : TransferError };
    icrc2_approve : shared (ApproveArg) -> async { #Ok : Nat; #Err : ApproveError };
    icrc2_transfer_from : shared (TransferFromArg) -> async { #Ok : Nat; #Err : TransferFromError };
    icrc2_allowance : shared query ({ account : Account; spender : Account }) -> async { allowance : Nat; expires_at : ?Nat64 };
  };

  // ---------- NAKSwap swap helper ----------

  public type HelperJob = {
    from : Account; // the order's deposit account; the router has approved the helper on it
    pull : Nat; // ICP the helper takes: amountIn + its approve fee + the pool's transfer_from fee
    amountIn : Nat;
    minOut : Nat;
    zeroForOne : Bool;
    icpFee : Nat;
    nakFee : Nat;
    returnTo : Account; // everything the helper holds afterwards goes back here
  };

  public type HelperResult = {
    #busy;
    #notAuthorized;
    // The helper holds funds from an earlier job: it refuses new work until an admin
    // returns them (so they can never be credited to someone else's order).
    #dirty : { icp : Nat; nak : Nat };
    // `clean`: afterwards the helper holds nothing (beyond fee dust) and nothing of its is
    // left in the pool. If false the router stops using it until an admin clears it.
    #done : { pulled : Bool; nakReturned : Nat; icpReturned : Nat; note : Text; clean : Bool };
  };

  public type Helper = actor {
    swap : shared HelperJob -> async HelperResult;
    returnAll : shared (Account, Nat, Nat) -> async { #ok : { nak : Nat; icp : Nat }; #err : Text };
    routerId : shared query () -> async Principal;
    poolUnused : shared () -> async { #ok : { icp : Nat; nak : Nat }; #err : Text };
    withdrawFromPool : shared (Bool, Nat, Nat) -> async { #ok : Nat; #err : Text };
  };

  // ---------- ICPSwap SwapPool (only the calls the router uses) ----------

  public type PoolError = {
    #CommonError;
    #InsufficientFunds;
    #InternalError : Text;
    #UnsupportedToken : Text;
  };

  public type SwapArgs = {
    amountIn : Text;
    zeroForOne : Bool;
    amountOutMinimum : Text;
  };

  public type WithdrawArgs = { amount : Nat; fee : Nat; token : Text };

  public type DepositAndSwapArgs = {
    amountIn : Text;
    zeroForOne : Bool;
    amountOutMinimum : Text;
    tokenInFee : Nat;
    tokenOutFee : Nat;
  };

  public type SwapPool = actor {
    quote : shared query (SwapArgs) -> async { #ok : Nat; #err : PoolError };
    depositFromAndSwap : shared (DepositAndSwapArgs) -> async { #ok : Nat; #err : PoolError };
    getUserUnusedBalance : shared query Principal -> async { #ok : { balance0 : Nat; balance1 : Nat }; #err : PoolError };
    withdraw : shared WithdrawArgs -> async { #ok : Nat; #err : PoolError };
  };
};
