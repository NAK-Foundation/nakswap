// A caller that is neither admin nor operator.
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Types "../router/types";

actor class Stranger() {
  type RouterApi = actor {
    createOrder : shared Types.CreateOrderArgs -> async Result.Result<Types.OrderView, Types.CreateOrderError>;
  };

  public func tryCreate(router : Principal, recipient : Principal) : async Bool {
    let r : RouterApi = actor (router.toText());
    switch (await r.createOrder({ recipient; refundTo = null; minNakOut = null })) {
      case (#ok _) { true };
      case (#err _) { false };
    };
  };
};
