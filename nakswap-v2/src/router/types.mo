module {

  public type Config = {
    admin : Principal;
    // Relay identities allowed to open orders (the relay holds the Houdini key).
    operators : [Principal];
    icpLedger : Principal;
    nakLedger : Principal;
    // ICPSwap NAK/ICP pool. Mainnet: d6hdt-qiaaa-aaaag-qm76q-cai (token0 = NAK, token1 = ICP).
    pool : Principal;
    icpIsToken0 : Bool;
    icpFee : Nat; // e8s, 10_000 on mainnet
    nakFee : Nat; // NAK ledger transfer fee in base units
    slippageBps : Nat; // tolerance vs the pool quote taken right before the swap
    maxImpactBps : Nat; // deposits that would move the price more than this are refunded as ICP
    minOrderIcp : Nat; // e8s
    maxOrderIcp : Nat; // e8s
    orderTtlSeconds : Nat; // how long to wait for Houdini to deliver ICP
    paused : Bool;
  };

  public type RefundReason = {
    #tooSmall;
    #tooLarge;
    #priceImpact : { bps : Nat };
    #swapFailed : Text;
    #admin;
  };

  public type Status = {
    // Waiting for Houdini to pay ICP into this order's deposit account.
    #awaitingDeposit;
    // ICP swept out of the deposit account and handed to ICPSwap; outcome not recorded yet.
    #swapping : { icpIn : Nat; startedAt : Int };
    // Swap done; NAK sits in the router's main account waiting to be sent.
    #payoutPending : { icpIn : Nat; nakAmount : Nat; createdAtTime : Nat64 };
    // ICP is going back to the user's principal instead of being swapped.
    #refundPending : {
      icpAmount : Nat;
      fromDeposit : Bool; // true: from the order's subaccount; false: from the router's main account
      reason : RefundReason;
      createdAtTime : Nat64;
    };
    #completed : { icpIn : Nat; nakOut : Nat; block : Nat };
    #refunded : { icpAmount : Nat; reason : RefundReason; block : Nat };
    #expired;
    #needsReview : Text;
  };

  public type Order = {
    id : Nat;
    recipient : Principal; // receives NAK
    refundTo : Principal; // receives ICP if the swap cannot happen
    minNakOut : Nat; // 0 = no user floor beyond the slippage guard
    createdAt : Int;
    subaccount : Blob;
    depositAccountId : Blob; // 32-byte ICP account identifier Houdini pays to
    var houdiniId : ?Text;
    var status : Status;
    var lastCheckedAt : Int;
  };

  public type OrderView = {
    id : Nat;
    recipient : Principal;
    refundTo : Principal;
    minNakOut : Nat;
    createdAt : Int;
    depositAccountId : Text; // hex, what goes into Houdini's addressTo
    houdiniId : ?Text;
    status : Status;
  };

  public type CreateOrderArgs = {
    recipient : Principal;
    refundTo : ?Principal;
    minNakOut : ?Nat;
  };

  public type CreateOrderError = {
    #notAuthorized;
    #paused;
    #anonymousRecipient;
    #invalidRecipient;
    #tooManyOpenOrders;
  };

  public type PokeResult = {
    #processed : Status;
    #busy;
    #tooSoon;
    #notFound;
    #notAuthorized;
  };

  public type Health = {
    cycles : Nat;
    lowCyclesThreshold : Nat;
    acceptingOrders : Bool;
    paused : Bool;
    activeOrders : Nat;
    nextOrderId : Nat;
    feeBps : Nat;
  };

  // NAKSwap fee: a share of the ICP each *completed* swap brings in, kept in the router's
  // main account (`accrued`) and swept to `to`. Refunded orders pay no fee.
  public type FeeSweep = { gross : Nat; amount : Nat; to : Principal; createdAtTime : Nat64 };

  public type FeeState = {
    var bps : Nat;
    var to : Principal;
    var accrued : Nat; // e8s held in main that belong to the fee wallet
    var paidTotal : Nat; // e8s delivered to fee wallets so far
    var stuck : Nat; // e8s whose sweep outcome is unknown (verify on the ledger)
    var pending : ?FeeSweep;
  };

  public type FeeStatus = {
    bps : Nat;
    to : Principal;
    accrued : Nat;
    paidTotal : Nat;
    stuck : Nat;
    pending : ?FeeSweep;
    autoSweepAt : Nat;
  };

  public type RouterState = {
    var config : Config;
    var nextId : Nat;
    var busy : Bool;
  };
};
