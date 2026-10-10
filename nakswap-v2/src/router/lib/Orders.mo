import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Account "../../common/Account";
import Types "../types";

module {

  public func create(id : Nat, self : Principal, sub : Blob, args : Types.CreateOrderArgs) : Types.Order {
    {
      id;
      recipient = args.recipient;
      refundTo = args.refundTo ?? args.recipient;
      minNakOut = args.minNakOut ?? 0;
      createdAt = Time.now();
      subaccount = sub;
      depositAccountId = Account.accountId(self, ?sub);
      var houdiniId = null;
      var status = #awaitingDeposit;
      var lastCheckedAt = 0;
    };
  };

  public func toView(self : Types.Order) : Types.OrderView {
    {
      id = self.id;
      recipient = self.recipient;
      refundTo = self.refundTo;
      minNakOut = self.minNakOut;
      createdAt = self.createdAt;
      depositAccountId = Account.toHex(self.depositAccountId);
      depositSubaccount = self.subaccount;
      houdiniId = self.houdiniId;
      status = self.status;
    };
  };

  public func isOperator(cfg : Types.Config, caller : Principal) : Bool {
    isAdmin(cfg, caller) or cfg.operators.any(func p = p == caller);
  };

  // The configured admin, or any controller of this canister (so limits can be changed
  // from a CLI key even when the admin is an Internet Identity / NNS principal).
  public func isAdmin(cfg : Types.Config, caller : Principal) : Bool {
    caller == cfg.admin or caller.isController();
  };
};
