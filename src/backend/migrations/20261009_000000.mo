import AccessControl "mo:caffeineai-authorization/access-control";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";

module {
  public type OldActor = {};

  public type RefundReason = {
    #tooSmall;
    #tooLarge;
    #priceImpact : { bps : Nat };
    #swapFailed : Text;
    #admin;
  };

  public type OrderStatus = {
    #awaitingDeposit;
    #swapping;
    #payoutPending;
    #refundPending;
    #completed : { icpIn : Nat; nakOut : Nat; block : Nat };
    #refunded : { icpAmount : Nat; reason : RefundReason; block : Nat };
    #expired;
    #needsReview : Text;
  };

  public type Order = {
    id : Nat;
    owner : Principal;
    recipient : Principal;
    depositAccountId : Text;
    depositSubaccount : Blob;
    createdAt : Int;
    updatedAt : Int;
    status : OrderStatus;
    quotedIcpIn : Nat;
    icpIn : ?Nat;
    nakOut : ?Nat;
    block : ?Nat;
    refundReason : ?RefundReason;
    minNakOut : ?Nat;
  };

  public type Config = {
    slippageBps : Nat;
    maxImpactBps : Nat;
    minOrderIcp : Nat;
    maxOrderIcp : Nat;
    orderTtlSeconds : Nat;
    paused : Bool;
    operators : [Principal];
  };

  public type Mode = { #sandbox; #live };

  public type TestToggles = {
    failNextNakPayout : Bool;
    poolWithdrawFailsNextSwap : Bool;
    forceSlippage : Bool;
  };

  public type PoolReserves = { icp : Nat; nak : Nat };

  public type NewActor = {
    accessControlState : AccessControl.AccessControlState;
    orders : Map.Map<Nat, Order>;
    config : { var value : Config };
    mode : { var value : Mode };
    testToggles : { var value : TestToggles };
    sandboxIcpBalances : Map.Map<Text, Nat>;
    sandboxNakBalances : Map.Map<Text, Nat>;
    sandboxAccountOwners : Map.Map<Text, Principal>;
    sandboxPool : { var value : PoolReserves };
    sandboxRouterMain : { var value : PoolReserves };
    busy : { var locked : Bool };
    nextOrderId : { var value : Nat };
  };

  public func migration(_ : OldActor) : NewActor {
    {
      accessControlState = AccessControl.initState();
      orders = Map.empty();
      config = {
        var value = {
          slippageBps = 100;
          maxImpactBps = 500;
          minOrderIcp = 10_000_000;
          maxOrderIcp = 5_000_000_000;
          orderTtlSeconds = 7200;
          paused = false;
          operators = [];
        };
      };
      mode = { var value = #sandbox };
      testToggles = {
        var value = {
          failNextNakPayout = false;
          poolWithdrawFailsNextSwap = false;
          forceSlippage = false;
        };
      };
      sandboxIcpBalances = Map.empty();
      sandboxNakBalances = Map.empty();
      sandboxAccountOwners = Map.empty();
      sandboxPool = { var value = { icp = 146_600_000_000; nak = 162_000_000_000_000_000 } };
      sandboxRouterMain = { var value = { icp = 0; nak = 0 } };
      busy = { var locked = false };
      nextOrderId = { var value = 0 };
    };
  };
};
