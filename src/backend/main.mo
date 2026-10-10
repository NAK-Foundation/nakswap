import Expose "mo:caffeineai-oql/Expose";
import ApiDocMixin "mixins/api-doc";
import SwapApi "mixins/swap-api";
import SwapLib "lib/swap";
import OqlLib "lib/oql";
import SwapTypes "types/swap";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Timer "mo:core/Timer";

actor self {
  // Swap domain stable state (initial values supplied by the migration chain).
  let orders : Map.Map<SwapTypes.OrderId, SwapTypes.Order>;
  let tokens : Map.Map<Text, SwapTypes.Token>;
  let icpUsdMicro : { var value : Nat };
  let config : { var value : SwapTypes.Config };
  let testToggles : { var value : SwapTypes.TestToggles };
  let sandboxIcpBalances : Map.Map<Text, Nat>;
  let sandboxNakBalances : Map.Map<Text, Nat>;
  let sandboxAccountOwners : Map.Map<Text, Principal>;
  let sandboxPool : { var value : SwapTypes.PoolReserves };
  let sandboxRouterMain : { var value : SwapTypes.PoolReserves };
  let busy : { var locked : Bool };
  let nextOrderId : { var value : Nat };

  // Shared mutable state record passed by reference to the swap mixin.
  // Transient: derived from the stable fields above, rebuilt on each start.
  transient let swapState : SwapLib.State = {
    selfPrincipal = Principal.fromActor(self);
    orders;
    tokens;
    icpUsdMicro;
    config;
    testToggles;
    sandboxIcpBalances;
    sandboxNakBalances;
    sandboxAccountOwners;
    sandboxPool;
    sandboxRouterMain;
    busy;
    nextOrderId;
  };

  include Expose({
    entities = OqlLib.entities(
      orders,
      tokens,
      config,
      sandboxIcpBalances,
      sandboxNakBalances,
      sandboxAccountOwners,
    );
  });
  include SwapApi(swapState);
  include ApiDocMixin();

  // Background timer: advance eligible orders every 20 seconds.
  transient let _swapTimer : Nat = Timer.recurringTimer<system>(
    #seconds(20),
    func() : async () {
      await SwapLib.processEligible(swapState);
    },
  );

  // Dedicated short timer: walk the Houdini leg a few seconds per step.
  transient let _houdiniTimer : Nat = Timer.recurringTimer<system>(
    #seconds(4),
    func() : async () {
      SwapLib.processHoudini(swapState);
    },
  );
};
