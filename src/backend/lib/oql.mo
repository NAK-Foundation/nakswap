import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import OQL "mo:caffeineai-oql";
import Entity "mo:caffeineai-oql/Entity";
import MapEntity "mo:caffeineai-oql/MapEntity";
import RecordValue "mo:caffeineai-oql/RecordValue";
import NatValue "mo:caffeineai-oql/NatValue";
import TextValue "mo:caffeineai-oql/TextValue";
import PrincipalValue "mo:caffeineai-oql/PrincipalValue";
import BoolValue "mo:caffeineai-oql/BoolValue";
import IntValue "mo:caffeineai-oql/IntValue";
import Types "../types/swap";

module {
  /// A flat, OQL-derivable projection of an order.
  public type OrderRow = {
    id : Nat;
    recipient : Principal;
    refundAddress : Text;
    tokenSymbol : Text;
    tokenChain : Text;
    tokenAmount : Nat;
    routeType : Text;
    depositAddress : Text;
    depositAccountId : Text;
    createdAt : Int;
    updatedAt : Int;
    houdiniStatus : Text;
    routerStatus : Text;
    icpIn : Nat;
    nakOut : Nat;
    block : Nat;
    refundReason : Text;
  };

  /// A flat projection of the router config.
  public type ConfigRow = {
    slippageBps : Nat;
    maxImpactBps : Nat;
    minOrderIcp : Nat;
    maxOrderIcp : Nat;
    orderTtlSeconds : Nat;
    paused : Bool;
  };

  /// A flat projection of a sandbox account balance.
  public type SandboxBalanceRow = {
    account : Text;
    owner : Principal;
    icp : Nat;
    nak : Nat;
  };

  /// A flat projection of a supported token.
  public type TokenRow = {
    symbol : Text;
    name : Text;
    chain : Text;
    usdMicro : Nat;
  };

  func statusTag(status : Types.RouterStatus) : Text {
    switch (status) {
      case (#awaitingDeposit) { "awaitingDeposit" };
      case (#swapping) { "swapping" };
      case (#payoutPending) { "payoutPending" };
      case (#completed) { "completed" };
      case (#refunded) { "refunded" };
      case (#needsReview(msg)) { "needsReview:" # msg };
    };
  };

  func refundTag(reason : ?Types.RefundReason) : Text {
    switch (reason) {
      case (null) { "" };
      case (?#tooSmall) { "tooSmall" };
      case (?#tooLarge) { "tooLarge" };
      case (?#priceImpact({ bps })) { "priceImpact:" # bps.toText() };
      case (?#swapFailed(msg)) { "swapFailed:" # msg };
      case (?#admin) { "admin" };
    };
  };

  func toOrderRow(order : Types.Order) : OrderRow {
    {
      id = order.id;
      recipient = order.recipient;
      refundAddress = order.refundAddress ?? "";
      tokenSymbol = order.tokenSymbol;
      tokenChain = order.tokenChain;
      tokenAmount = order.tokenAmount;
      routeType = switch (order.routeType) { case (#standard) { "standard" }; case (#private_) { "private" } };
      depositAddress = order.depositAddress;
      depositAccountId = order.depositAccountId;
      createdAt = order.createdAt;
      updatedAt = order.updatedAt;
      houdiniStatus = switch (order.houdiniStatus) {
        case (#waiting) { "waiting" };
        case (#confirming) { "confirming" };
        case (#exchanging) { "exchanging" };
        case (#anonymizing) { "anonymizing" };
        case (#completed) { "completed" };
        case (#expired) { "expired" };
        case (#failed) { "failed" };
        case (#refunded) { "refunded" };
      };
      routerStatus = statusTag(order.routerStatus);
      icpIn = order.icpIn ?? 0;
      nakOut = order.nakOut ?? 0;
      block = order.block ?? 0;
      refundReason = refundTag(order.refundReason);
    };
  };

  /// Build the OQL entities for the swap lab's persisted collections.
  public func entities(
    orders : Map.Map<Types.OrderId, Types.Order>,
    tokens : Map.Map<Text, Types.Token>,
    config : { var value : Types.Config },
    sandboxIcpBalances : Map.Map<Text, Nat>,
    sandboxNakBalances : Map.Map<Text, Nat>,
    sandboxAccountOwners : Map.Map<Text, Principal>,
  ) : [OQL.Entity.Decl] {
    let orderRows : Map.Map<Nat, OrderRow> = orders.map(func(_, o) = toOrderRow(o));
    let tokenRows : Map.Map<Text, TokenRow> = tokens.map(func(_, t) = {
      symbol = t.symbol;
      name = t.name;
      chain = t.chain;
      usdMicro = t.usdMicro;
    });
    let configRows : Map.Map<Nat, ConfigRow> = Map.singleton(0, {
      slippageBps = config.value.slippageBps;
      maxImpactBps = config.value.maxImpactBps;
      minOrderIcp = config.value.minOrderIcp;
      maxOrderIcp = config.value.maxOrderIcp;
      orderTtlSeconds = config.value.orderTtlSeconds;
      paused = config.value.paused;
    });
    let balanceRows : Map.Map<Text, SandboxBalanceRow> = sandboxNakBalances.map(func(account, nak) = {
      account;
      owner = sandboxAccountOwners.get(account) ?? Principal.fromText("2vxsx-fae");
      icp = sandboxIcpBalances.get(account) ?? 0;
      nak;
    });
    [
      orderRows.toEntity("order", "OrderRow", "id")
        .sample({
          id = 0;
          recipient = Principal.fromText("2vxsx-fae");
          refundAddress = "";
          tokenSymbol = "";
          tokenChain = "";
          tokenAmount = 0;
          routeType = "";
          depositAddress = "";
          depositAccountId = "";
          createdAt = 0;
          updatedAt = 0;
          houdiniStatus = "";
          routerStatus = "";
          icpIn = 0;
          nakOut = 0;
          block = 0;
          refundReason = "";
        })
        .controllerOnly()
        .build(),
      tokenRows.toEntity("token", "TokenRow", "symbol")
        .sample({ symbol = ""; name = ""; chain = ""; usdMicro = 0 })
        .controllerOnly()
        .build(),
      configRows.toEntity("config", "ConfigRow", "slippageBps")
        .sample({
          slippageBps = 0;
          maxImpactBps = 0;
          minOrderIcp = 0;
          maxOrderIcp = 0;
          orderTtlSeconds = 0;
          paused = false;
        })
        .controllerOnly()
        .build(),
      balanceRows.toEntity("sandboxBalance", "SandboxBalanceRow", "account")
        .sample({ account = ""; owner = Principal.fromText("2vxsx-fae"); icp = 0; nak = 0 })
        .controllerOnly()
        .build(),
    ];
  };
};
