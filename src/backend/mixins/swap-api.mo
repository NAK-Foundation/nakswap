import Principal "mo:core/Principal";
import SwapLib "../lib/swap";
import Types "../types/swap";

mixin (state : SwapLib.State) {
  /// Two-leg quote preview for a prospective order.
  public query func getQuote(tokenSymbol : Text, tokenAmount : Nat, routeType : Types.RouteType) : async Types.Quote {
    SwapLib.quote(state, tokenSymbol, tokenAmount, routeType);
  };

  /// Create a new order; returns the order id.
  public shared func createOrder(
    recipient : Principal,
    tokenSymbol : Text,
    tokenAmount : Nat,
    routeType : Types.RouteType,
    refundAddress : ?Text,
  ) : async Types.OrderId {
    SwapLib.createOrder(state, recipient, tokenSymbol, tokenAmount, routeType, refundAddress);
  };

  /// List orders, optionally filtered by router status.
  public query func listOrders(filter : ?Types.RouterStatus) : async [Types.OrderSummary] {
    SwapLib.listOrders(state, filter);
  };

  /// Fetch a single order by id.
  public query func getOrder(id : Types.OrderId) : async ?Types.Order {
    SwapLib.getOrder(state, id);
  };

  /// Simulate the user having sent the source token ("I've sent it").
  public shared func simulateDeposit(id : Types.OrderId) : async () {
    SwapLib.simulateDeposit(state, id);
  };

  /// Advance a single order through the router pipeline.
  public shared func processOrder(id : Types.OrderId) : async Types.ProcessResult {
    await SwapLib.processOrder(state, id);
  };

  /// Read the current config.
  public query func getConfig() : async Types.Config {
    SwapLib.getConfig(state);
  };

  /// Update the config.
  public shared func setConfig(config : Types.Config) : async () {
    SwapLib.setConfig(state, config);
  };

  /// Read the sandbox test toggles.
  public query func getTestToggles() : async Types.TestToggles {
    SwapLib.getTestToggles(state);
  };

  /// Update the sandbox test toggles.
  public shared func setTestToggles(toggles : Types.TestToggles) : async () {
    SwapLib.setTestToggles(state, toggles);
  };

  /// Read the sandbox balances snapshot.
  public query func getSandboxBalances() : async Types.SandboxBalances {
    SwapLib.getSandboxBalances(state);
  };

  /// Read the token catalogue.
  public query func listTokens() : async [Types.Token] {
    SwapLib.listTokens(state);
  };

  /// Update a token's USD price.
  public shared func setTokenPrice(symbol : Text, usdMicro : Nat) : async () {
    SwapLib.setTokenPrice(state, symbol, usdMicro);
  };

  /// Read the ICP USD price.
  public query func getIcpPrice() : async Nat {
    SwapLib.getIcpPrice(state);
  };

  /// Update the ICP USD price.
  public shared func setIcpPrice(usdMicro : Nat) : async () {
    SwapLib.setIcpPrice(state, usdMicro);
  };

  /// Read the simulated NAK balance of a principal.
  public query func getNakBalance(principal : Principal) : async Nat {
    SwapLib.getNakBalance(state, principal);
  };

  /// Reset the sandbox to its seeded state.
  public shared func resetSandbox() : async () {
    SwapLib.resetSandbox(state);
  };
};
