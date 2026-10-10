import Common "common";

module {
  public type OrderId = Common.OrderId;
  public type Timestamp = Common.Timestamp;
  public type AccountId = Common.AccountId;
  public type Amount = Common.Amount;
  public type Bps = Common.Bps;
  public type BlockIndex = Common.BlockIndex;
  public type RouteType = Common.RouteType;

  /// A supported source token, priced in USD.
  public type Token = {
    symbol : Text;
    name : Text;
    chain : Text;
    /// USD price in micro-dollars (1_000_000 = $1.00).
    usdMicro : Nat;
  };

  /// Why an order was refunded.
  public type RefundReason = {
    #tooSmall;
    #tooLarge;
    #priceImpact : { bps : Bps };
    #swapFailed : Text;
    #admin;
  };

  /// Houdini leg status (leg 1: source token → ICP).
  public type HoudiniStatus = {
    #waiting;
    #confirming;
    #exchanging;
    #anonymizing;
    #completed;
    #expired;
    #failed;
    #refunded;
  };

  /// Router leg status (leg 2: ICP → NAK on the simulated ICPSwap pool).
  public type RouterStatus = {
    #awaitingDeposit;
    #swapping;
    #payoutPending;
    #completed;
    #refunded;
    #needsReview : Text;
  };

  /// Full order record as exposed to the API.
  public type Order = {
    id : OrderId;
    /// Typed NAK recipient principal (never anonymous).
    recipient : Principal;
    /// Optional source-chain refund address (stored and shown only).
    refundAddress : ?Text;
    /// Source token symbol.
    tokenSymbol : Text;
    /// Source token chain.
    tokenChain : Text;
    /// Amount of the source token the user sends (smallest unit of that token).
    tokenAmount : Nat;
    /// Route type chosen for the Houdini leg.
    routeType : RouteType;
    /// Fake chain-correct deposit address for the source token.
    depositAddress : Text;
    /// Router-derived 64-hex ICP deposit account id.
    depositAccountId : AccountId;
    depositSubaccount : Blob;
    createdAt : Timestamp;
    updatedAt : Timestamp;
    houdiniStatus : HoudiniStatus;
    routerStatus : RouterStatus;
    /// ICP credited to the deposit account when the Houdini leg completes.
    icpIn : ?Amount;
    /// NAK amount sent to the recipient, once completed.
    nakOut : ?Amount;
    /// Block index of the NAK payout or ICP refund.
    block : ?BlockIndex;
    /// Refund reason, once refunded.
    refundReason : ?RefundReason;
  };

  /// Compact order summary for list views.
  public type OrderSummary = {
    id : OrderId;
    recipient : Principal;
    tokenSymbol : Text;
    tokenChain : Text;
    tokenAmount : Nat;
    routeType : RouteType;
    houdiniStatus : HoudiniStatus;
    routerStatus : RouterStatus;
    createdAt : Timestamp;
    updatedAt : Timestamp;
  };

  /// One leg of the quote breakdown.
  public type HoudiniLeg = {
    tokenSymbol : Text;
    tokenChain : Text;
    tokenAmount : Nat;
    icpOut : Amount;
    feeBps : Bps;
    etaSeconds : Nat;
    routeType : RouteType;
  };

  /// The router leg of the quote breakdown.
  public type RouterLeg = {
    icpIn : Amount;
    icpAfterFees : Amount;
    nakOut : Amount;
    priceImpactBps : Bps;
    minNakOut : Amount;
    wouldRefund : Bool;
    verdict : Text;
  };

  /// Live quote preview for a prospective order.
  public type Quote = {
    tokenSymbol : Text;
    tokenChain : Text;
    tokenAmount : Nat;
    icpUsdMicro : Nat;
    tokenUsdMicro : Nat;
    houdini : HoudiniLeg;
    router : RouterLeg;
  };

  /// Editable router configuration.
  public type Config = {
    slippageBps : Bps;
    maxImpactBps : Bps;
    minOrderIcp : Amount;
    maxOrderIcp : Amount;
    orderTtlSeconds : Nat;
    paused : Bool;
  };

  /// Test toggles for sandbox simulation.
  public type TestToggles = {
    failNextNakPayout : Bool;
    poolWithdrawFailsNextSwap : Bool;
    houdiniLegFailsNextOrder : Bool;
  };

  /// Simulated pool reserves.
  public type PoolReserves = {
    icp : Amount;
    nak : Amount;
  };

  /// Sandbox balances snapshot.
  public type SandboxBalances = {
    pool : PoolReserves;
    routerMainIcp : Amount;
    routerMainNak : Amount;
    users : [{ principal : Principal; icp : Amount; nak : Amount }];
  };

  /// Result of processing an order.
  public type ProcessResult = {
    #advanced : RouterStatus;
    #busy;
    #noop;
  };
};
