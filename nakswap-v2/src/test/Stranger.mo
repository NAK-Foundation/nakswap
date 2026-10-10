// A caller that is neither admin nor operator.
import Principal "mo:core/Principal";
import Result "mo:core/Result";
import Types "../router/types";
import Ext "../common/Ext";

actor class Stranger() {
  type RouterApi = actor {
    createOrder : shared Types.CreateOrderArgs -> async Result.Result<Types.OrderView, Types.CreateOrderError>;
    setFee : shared (Nat, Principal) -> async Bool;
    sweepFees : shared () -> async Nat;
    poke : shared Nat -> async Types.PokeResult;
    getOrder : shared query Nat -> async ?Types.OrderView;
    cancelUnfunded : shared Nat -> async Bool;
  };

  public func tryCancel(router : Principal, id : Nat) : async Bool {
    let r : RouterApi = actor (router.toText());
    await r.cancelUnfunded(id);
  };

  public func trySwap(helper : Principal) : async Ext.HelperResult {
    let h : Ext.Helper = actor (helper.toText());
    await h.swap({
      strayTo = { owner = helper; subaccount = null };
      from = { owner = helper; subaccount = null };
      pull = 1;
      amountIn = 1;
      minOut = 0;
      zeroForOne = false;
      icpFee = 0;
      nakFee = 0;
      returnTo = { owner = helper; subaccount = null };
    });
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
