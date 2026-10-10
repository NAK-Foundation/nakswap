// A caller that is neither admin nor operator.
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Types "../router/types";

actor class Stranger() {
  type RouterApi = actor {
    createOrder : shared Types.CreateOrderArgs -> async Result.Result<Types.OrderView, Types.CreateOrderError>;
    setFee : shared (Nat, Principal) -> async Bool;
    sweepFees : shared () -> async Nat;
    poke : shared Nat -> async Types.PokeResult;
    getOrder : shared query Nat -> async ?Types.OrderView;
  };

  public func tryPoke(router : Principal, id : Nat) : async Types.PokeResult {
    let r : RouterApi = actor (router.toText());
    await r.poke(id);
  };

  public func tryGetOrder(router : Principal, id : Nat) : async ?Types.OrderView {
    let r : RouterApi = actor (router.toText());
    await r.getOrder(id);
  };

  public func trySetFee(router : Principal, to : Principal) : async Bool {
    let r : RouterApi = actor (router.toText());
    await r.setFee(400, to);
  };

  public func trySweep(router : Principal) : async Nat {
    let r : RouterApi = actor (router.toText());
    await r.sweepFees();
  };

  public func tryCreate(router : Principal, recipient : Principal) : async Bool {
    let r : RouterApi = actor (router.toText());
    switch (await r.createOrder({ recipient; refundTo = null; minNakOut = null })) {
      case (#ok _) { true };
      case (#err _) { false };
    };
  };
};
