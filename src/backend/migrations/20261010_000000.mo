import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";

module {
  // The previously deployed stable signature (from the .most baseline):
  // accessControlState, orders, config, mode, testToggles, sandbox* maps,
  // sandboxPool, sandboxRouterMain, busy, nextOrderId.
  public type OldActor = {
    accessControlState : {
      var adminAssigned : Bool;
      userRoles : Map.Map<Principal, { #admin; #guest; #user }>;
    };
    orders : Map.Map<Nat, OldOrder>;
    config : { var value : OldConfig };
    mode : { var value : { #sandbox; #live } };
    testToggles : { var value : OldTestToggles };
    sandboxIcpBalances : Map.Map<Text, Nat>;
    sandboxNakBalances : Map.Map<Text, Nat>;
    sandboxAccountOwners : Map.Map<Text, Principal>;
    sandboxPool : { var value : OldPoolReserves };
    sandboxRouterMain : { var value : OldPoolReserves };
    busy : { var locked : Bool };
    nextOrderId : { var value : Nat };
  };

  public type OldConfig = {
    slippageBps : Nat;
    maxImpactBps : Nat;
    minOrderIcp : Nat;
    maxOrderIcp : Nat;
    orderTtlSeconds : Nat;
    paused : Bool;
    operators : [Principal];
  };

  public type OldTestToggles = {
    failNextNakPayout : Bool;
    poolWithdrawFailsNextSwap : Bool;
    forceSlippage : Bool;
  };

  public type OldPoolReserves = { icp : Nat; nak : Nat };

  public type OldOrder = {
    id : Nat;
    owner : Principal;
    recipient : Principal;
    depositAccountId : Text;
    depositSubaccount : Blob;
    createdAt : Int;
    updatedAt : Int;
    status : OldOrderStatus;
    quotedIcpIn : Nat;
    icpIn : ?Nat;
    nakOut : ?Nat;
    block : ?Nat;
    refundReason : ?OldRefundReason;
    minNakOut : ?Nat;
  };

  public type OldRefundReason = {
    #tooSmall;
    #tooLarge;
    #priceImpact : { bps : Nat };
    #swapFailed : Text;
    #admin;
  };

  public type OldOrderStatus = {
    #awaitingDeposit;
    #swapping;
    #payoutPending;
    #refundPending;
    #completed : { icpIn : Nat; nakOut : Nat; block : Nat };
    #refunded : { icpAmount : Nat; reason : OldRefundReason; block : Nat };
    #expired;
    #needsReview : Text;
  };

  public type RouteType = { #standard; #private_ };

  public type Token = {
    symbol : Text;
    name : Text;
    chain : Text;
    usdMicro : Nat;
  };

  public type RefundReason = {
    #tooSmall;
    #tooLarge;
    #priceImpact : { bps : Nat };
    #swapFailed : Text;
    #admin;
  };

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

  public type RouterStatus = {
    #awaitingDeposit;
    #swapping;
    #payoutPending;
    #completed;
    #refunded;
    #needsReview : Text;
  };

  public type Order = {
    id : Nat;
    recipient : Principal;
    refundAddress : ?Text;
    tokenSymbol : Text;
    tokenChain : Text;
    tokenAmount : Nat;
    routeType : RouteType;
    depositAddress : Text;
    depositAccountId : Text;
    depositSubaccount : Blob;
    createdAt : Int;
    updatedAt : Int;
    houdiniStatus : HoudiniStatus;
    routerStatus : RouterStatus;
    icpIn : ?Nat;
    nakOut : ?Nat;
    block : ?Nat;
    refundReason : ?RefundReason;
  };

  public type Config = {
    slippageBps : Nat;
    maxImpactBps : Nat;
    minOrderIcp : Nat;
    maxOrderIcp : Nat;
    orderTtlSeconds : Nat;
    paused : Bool;
  };

  public type TestToggles = {
    failNextNakPayout : Bool;
    poolWithdrawFailsNextSwap : Bool;
    houdiniLegFailsNextOrder : Bool;
  };

  public type PoolReserves = { icp : Nat; nak : Nat };

  public type NewActor = {
    orders : Map.Map<Nat, Order>;
    tokens : Map.Map<Text, Token>;
    icpUsdMicro : { var value : Nat };
    config : { var value : Config };
    testToggles : { var value : TestToggles };
    sandboxIcpBalances : Map.Map<Text, Nat>;
    sandboxNakBalances : Map.Map<Text, Nat>;
    sandboxAccountOwners : Map.Map<Text, Principal>;
    sandboxPool : { var value : PoolReserves };
    sandboxRouterMain : { var value : PoolReserves };
    busy : { var locked : Bool };
    nextOrderId : { var value : Nat };
  };

  public func migration(old : OldActor) : NewActor {
    let tokens = Map.empty<Text, Token>();
    let seeds : [Token] = [
      { symbol = "BTC"; name = "Bitcoin"; chain = "Bitcoin"; usdMicro = 65_000_000_000 },
      { symbol = "ETH"; name = "Ethereum"; chain = "Ethereum"; usdMicro = 3_200_000_000 },
      { symbol = "USDT"; name = "Tether"; chain = "Ethereum"; usdMicro = 1_000_000 },
      { symbol = "USDT"; name = "Tether"; chain = "Tron"; usdMicro = 1_000_000 },
      { symbol = "USDT"; name = "Tether"; chain = "Solana"; usdMicro = 1_000_000 },
      { symbol = "USDC"; name = "USD Coin"; chain = "Ethereum"; usdMicro = 1_000_000 },
      { symbol = "USDC"; name = "USD Coin"; chain = "Base"; usdMicro = 1_000_000 },
      { symbol = "USDC"; name = "USD Coin"; chain = "Solana"; usdMicro = 1_000_000 },
      { symbol = "SOL"; name = "Solana"; chain = "Solana"; usdMicro = 150_000_000 },
      { symbol = "BNB"; name = "BNB"; chain = "BSC"; usdMicro = 580_000_000 },
      { symbol = "XRP"; name = "XRP"; chain = "Ripple"; usdMicro = 520_000 },
      { symbol = "DOGE"; name = "Dogecoin"; chain = "Doge"; usdMicro = 120_000 },
      { symbol = "LTC"; name = "Litecoin"; chain = "Litecoin"; usdMicro = 85_000_000 },
      { symbol = "TRX"; name = "TRON"; chain = "Tron"; usdMicro = 130_000 },
      { symbol = "ADA"; name = "Cardano"; chain = "Cardano"; usdMicro = 450_000 },
      { symbol = "AVAX"; name = "Avalanche"; chain = "Avalanche"; usdMicro = 28_000_000 },
      { symbol = "POL"; name = "Polygon"; chain = "Polygon"; usdMicro = 450_000 },
      { symbol = "TON"; name = "Toncoin"; chain = "TON"; usdMicro = 5_500_000 },
      { symbol = "XMR"; name = "Monero"; chain = "Monero"; usdMicro = 160_000_000 },
      { symbol = "SUI"; name = "Sui"; chain = "Sui"; usdMicro = 1_200_000 },
      { symbol = "ICP"; name = "Internet Computer"; chain = "Internet Computer"; usdMicro = 3_000_000 },
    ];
    for (token in seeds.values()) {
      tokens.add(token.symbol # ":" # token.chain, token);
    };
    // Reshape each old order into the new two-leg order shape. The old order
    // carried a single `status`; map it onto the router leg and mark the
    // Houdini leg completed for orders that had already progressed.
    let orders = old.orders.map<Nat, OldOrder, Order>(
      func(_, o) {
        let (houdiniStatus, routerStatus) = switch (o.status) {
          case (#awaitingDeposit) { (#waiting, #awaitingDeposit) };
          case (#swapping) { (#completed, #swapping) };
          case (#payoutPending) { (#completed, #payoutPending) };
          case (#refundPending) { (#completed, #refunded) };
          case (#completed(_)) { (#completed, #completed) };
          case (#refunded(_)) { (#completed, #refunded) };
          case (#expired) { (#expired, #refunded) };
          case (#needsReview(msg)) { (#completed, #needsReview(msg)) };
        };
        {
          id = o.id;
          recipient = o.recipient;
          refundAddress = null;
          tokenSymbol = "ICP";
          tokenChain = "Internet Computer";
          tokenAmount = o.quotedIcpIn;
          routeType = #standard;
          depositAddress = "";
          depositAccountId = o.depositAccountId;
          depositSubaccount = o.depositSubaccount;
          createdAt = o.createdAt;
          updatedAt = o.updatedAt;
          houdiniStatus;
          routerStatus;
          icpIn = o.icpIn;
          nakOut = o.nakOut;
          block = o.block;
          refundReason = o.refundReason;
        };
      },
    );
    {
      orders;
      tokens;
      icpUsdMicro = { var value = 3_000_000 };
      config = {
        var value = {
          slippageBps = old.config.value.slippageBps;
          maxImpactBps = old.config.value.maxImpactBps;
          minOrderIcp = old.config.value.minOrderIcp;
          maxOrderIcp = old.config.value.maxOrderIcp;
          orderTtlSeconds = old.config.value.orderTtlSeconds;
          paused = old.config.value.paused;
        };
      };
      testToggles = {
        var value = {
          failNextNakPayout = old.testToggles.value.failNextNakPayout;
          poolWithdrawFailsNextSwap = old.testToggles.value.poolWithdrawFailsNextSwap;
          houdiniLegFailsNextOrder = false;
        };
      };
      sandboxIcpBalances = old.sandboxIcpBalances;
      sandboxNakBalances = old.sandboxNakBalances;
      sandboxAccountOwners = old.sandboxAccountOwners;
      sandboxPool = old.sandboxPool;
      sandboxRouterMain = old.sandboxRouterMain;
      busy = old.busy;
      nextOrderId = old.nextOrderId;
    };
  };
};
