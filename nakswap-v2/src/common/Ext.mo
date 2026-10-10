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

  public type Ledger = actor {
    icrc1_balance_of : shared query (Account) -> async Nat;
    icrc1_transfer : shared (TransferArg) -> async { #Ok : Nat; #Err : TransferError };
    icrc2_approve : shared (ApproveArg) -> async { #Ok : Nat; #Err : ApproveError };
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
  };
};
