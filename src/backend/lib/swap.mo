import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Types "../types/swap";

module {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /// ICP ledger fee in e8s.
  public let ICP_FEE : Nat = 10_000;
  /// NAK ledger fee in 8-decimal units.
  public let NAK_FEE : Nat = 1_000_000;
  /// Simulated ICPSwap pool fee (0.3%).
  public let POOL_FEE_BPS : Nat = 30;
  /// Probe quote size used to estimate price impact (0.01 ICP).
  public let PROBE_ICP : Nat = 1_000_000;
  /// Basis-point denominator.
  public let BPS_DENOM : Nat = 10_000;
  /// Houdini Standard route fee (0.8%).
  public let HOUDINI_STANDARD_FEE_BPS : Nat = 80;
  /// Houdini Private route fee (1.5%).
  public let HOUDINI_PRIVATE_FEE_BPS : Nat = 150;
  /// Deposit subaccount prefix: 0x4E 0x41 0x4B ("NAK").
  public let SUBACCOUNT_PREFIX : [Nat8] = [0x4E, 0x41, 0x4B];
  /// Houdini leg expiry in seconds.
  public let HOUDINI_TTL_SECONDS : Nat = 1800;

  // ---------------------------------------------------------------------------
  // Shared mutable state (owned by main.mo, passed in by reference)
  // ---------------------------------------------------------------------------

  public type State = {
    selfPrincipal : Principal;
    orders : Map.Map<Types.OrderId, Types.Order>;
    tokens : Map.Map<Text, Types.Token>;
    icpUsdMicro : { var value : Nat };
    config : { var value : Types.Config };
    testToggles : { var value : Types.TestToggles };
    sandboxIcpBalances : Map.Map<Text, Nat>;
    sandboxNakBalances : Map.Map<Text, Nat>;
    sandboxAccountOwners : Map.Map<Text, Principal>;
    sandboxPool : { var value : Types.PoolReserves };
    sandboxRouterMain : { var value : Types.PoolReserves };
    busy : { var locked : Bool };
    nextOrderId : { var value : Nat };
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  func feeBps(routeType : Types.RouteType) : Nat {
    switch (routeType) {
      case (#standard) { HOUDINI_STANDARD_FEE_BPS };
      case (#private_) { HOUDINI_PRIVATE_FEE_BPS };
    };
  };

  func etaSeconds(routeType : Types.RouteType) : Nat {
    switch (routeType) {
      case (#standard) { 600 };
      case (#private_) { 1800 };
    };
  };

  func applyBps(amount : Nat, bps : Nat) : Nat {
    (amount * (BPS_DENOM - bps)) / BPS_DENOM;
  };

  func bpsOf(part : Nat, whole : Nat) : Nat {
    if (whole == 0) { 0 } else { (part * BPS_DENOM) / whole };
  };

  func absDiff(a : Nat, b : Nat) : Nat {
    if (a >= b) { a - b } else { b - a };
  };

  func isAnonymous(p : Principal) : Bool {
    p.isAnonymous();
  };

  func tokenKey(symbol : Text, chain : Text) : Text {
    symbol # ":" # chain;
  };

  // ---------------------------------------------------------------------------
  // Subaccount / account identifier helpers
  // ---------------------------------------------------------------------------

  /// Build the 32-byte deposit subaccount for an order.
  public func depositSubaccount(orderId : Types.OrderId) : Blob {
    let bytes = Array.tabulate<Nat8>(
      32,
      func(i) {
        if (i < 3) { SUBACCOUNT_PREFIX[i] } else if (i < 24) { 0 } else {
          ((orderId / (256 ** (31 - i))) % 256).toNat8()
        };
      },
    );
    bytes.toBlob();
  };

  /// 64-hex ICP account identifier for a principal + subaccount.
  public func accountIdOf(principal : Principal, subaccount : Blob) : Types.AccountId {
    let sub = subaccount.toArray();
    let padded = Array.tabulate<Nat8>(32, func(i) = if (i < sub.size()) { sub[i] } else { 0 });
    let p = principal.toBlob().toArray();
    let pp = Array.tabulate<Nat8>(29, func(i) = if (i < p.size()) { p[i] } else { 0 });
    let tail : [Nat8] = [0x80, 0, 0, 0];
    let preimage = pp.concat(padded).concat(tail);
    let crc = crc32(preimage);
    let checksum = Array.tabulate(4, func(i) = Nat8.fromNat(Nat32.toNat((crc >> ((3 - i) * 8).toNat32()) & 0xFF)));
    let body = Array.tabulate<Nat8>(28, func(i) = if (i < p.size()) { p[i] } else { 0 });
    let account = checksum.concat(body);
    account.foldLeft("", func(acc, b) = acc # hexByte(b));
  };

  func crc32(bytes : [Nat8]) : Nat32 {
    var c : Nat32 = 0xFFFFFFFF;
    for (b in bytes.values()) {
      c := c ^ b.toNat32();
      var k = 0;
      while (k < 8) {
        c := if (c & 1 == 1) { (c >> 1) ^ 0xEDB88320 } else { c >> 1 };
        k += 1;
      };
    };
    c ^ 0xFFFFFFFF;
  };

  func hexByte(b : Nat8) : Text {
    let n = b.toNat();
    hexDigit(n / 16) # hexDigit(n % 16);
  };

  func hexDigit(n : Nat) : Text {
    switch (n) {
      case (0) { "0" }; case (1) { "1" }; case (2) { "2" }; case (3) { "3" };
      case (4) { "4" }; case (5) { "5" }; case (6) { "6" }; case (7) { "7" };
      case (8) { "8" }; case (9) { "9" }; case (10) { "a" }; case (11) { "b" };
      case (12) { "c" }; case (13) { "d" }; case (14) { "e" }; case (_) { "f" };
    };
  };

  // ---------------------------------------------------------------------------
  // Simulated constant-product pool
  // ---------------------------------------------------------------------------

  /// Constant-product quote with a 0.3% fee. Returns the output amount.
  public func poolQuote(poolReserves : Types.PoolReserves, amountIn : Nat, zeroForOne : Bool) : Nat {
    let (rin, rout) = if (zeroForOne) { (poolReserves.icp, poolReserves.nak) } else {
      (poolReserves.nak, poolReserves.icp);
    };
    if (rin == 0 or rout == 0) { 0 } else {
      let amountInAfterFee = amountIn * (BPS_DENOM - POOL_FEE_BPS) / BPS_DENOM;
      (rout * amountInAfterFee) / (rin + amountInAfterFee);
    };
  };

  /// Execute a swap against the simulated pool, returning the new reserves and output.
  public func poolSwap(poolReserves : Types.PoolReserves, amountIn : Nat, zeroForOne : Bool) : (Types.PoolReserves, Nat) {
    let out = poolQuote(poolReserves, amountIn, zeroForOne);
    if (zeroForOne) {
      ({ icp = poolReserves.icp + amountIn; nak = poolReserves.nak - out }, out);
    } else {
      ({ icp = poolReserves.icp - out; nak = poolReserves.nak + amountIn }, out);
    };
  };

  // ---------------------------------------------------------------------------
  // Quote
  // ---------------------------------------------------------------------------

  /// Compute the two-leg quote for a prospective order.
  public func quote(state : State, tokenSymbol : Text, tokenAmount : Nat, routeType : Types.RouteType) : Types.Quote {
    let token = state.tokens.get(tokenSymbol) ?? Runtime.trap("Unknown token");
    let icpUsd = state.icpUsdMicro.value;
    let fee = feeBps(routeType);
    let icpOut = if (icpUsd == 0) { 0 } else {
      applyBps(tokenAmount * token.usdMicro / icpUsd, fee)
    };
    let icpAfterFees = if (icpOut > ICP_FEE) { icpOut - ICP_FEE } else { 0 };
    let nakOut = poolQuote(state.sandboxPool.value, icpAfterFees, true);
    let probeOut = poolQuote(state.sandboxPool.value, PROBE_ICP, true);
    let spot = if (state.sandboxPool.value.icp == 0) { 0 } else {
      state.sandboxPool.value.nak / state.sandboxPool.value.icp
    };
    let priceImpactBps = if (probeOut == 0 or spot == 0) { 0 } else {
      bpsOf(absDiff(probeOut, spot), spot)
    };
    let minNakOut = applyBps(nakOut, state.config.value.slippageBps);
    let tooSmall = icpAfterFees < state.config.value.minOrderIcp;
    let tooLarge = icpAfterFees > state.config.value.maxOrderIcp;
    let tooHigh = priceImpactBps > state.config.value.maxImpactBps;
    let wouldRefund = tooSmall or tooLarge or tooHigh;
    let verdict = if (tooSmall) { "Refund: ICP after fees is below the minimum order size" } else if (tooLarge) {
      "Refund: ICP after fees is above the maximum order size";
    } else if (tooHigh) { "Refund: price impact exceeds the maximum" } else {
      "OK: the router would swap and pay out NAK"
    };
    {
      tokenSymbol = token.symbol;
      tokenChain = token.chain;
      tokenAmount;
      icpUsdMicro = icpUsd;
      tokenUsdMicro = token.usdMicro;
      houdini = {
        tokenSymbol = token.symbol;
        tokenChain = token.chain;
        tokenAmount;
        icpOut;
        feeBps = fee;
        etaSeconds = etaSeconds(routeType);
        routeType;
      };
      router = {
        icpIn = icpOut;
        icpAfterFees;
        nakOut;
        priceImpactBps;
        minNakOut;
        wouldRefund;
        verdict;
      };
    };
  };

  // ---------------------------------------------------------------------------
  // Order creation / reads
  // ---------------------------------------------------------------------------

  /// Create a new order with its own deposit subaccount; returns the order id.
  public func createOrder(
    state : State,
    recipient : Principal,
    tokenSymbol : Text,
    tokenAmount : Nat,
    routeType : Types.RouteType,
    refundAddress : ?Text,
  ) : Types.OrderId {
    if (isAnonymous(recipient)) {
      Runtime.trap("Recipient must not be the anonymous principal");
    };
    let token = state.tokens.get(tokenSymbol) ?? Runtime.trap("Unknown token");
    let id = state.nextOrderId.value;
    state.nextOrderId.value := id + 1;
    let subaccount = depositSubaccount(id);
    let accountId = accountIdOf(state.selfPrincipal, subaccount);
    let now = Time.now();
    let order : Types.Order = {
      id;
      recipient;
      refundAddress;
      tokenSymbol = token.symbol;
      tokenChain = token.chain;
      tokenAmount;
      routeType;
      depositAddress = fakeDepositAddress(token.chain, id);
      depositAccountId = accountId;
      depositSubaccount = subaccount;
      createdAt = now;
      updatedAt = now;
      houdiniStatus = #waiting;
      routerStatus = #awaitingDeposit;
      icpIn = null;
      nakOut = null;
      block = null;
      refundReason = null;
    };
    state.orders.add(id, order);
    id;
  };

  func fakeDepositAddress(chain : Text, id : Nat) : Text {
    let hex = id.toText();
    if (chain == "Bitcoin") { "bc1q" # hex # "nak0sandbox0x7f3a" } else if (chain == "Tron") {
      "T" # hex # "Nak9Sandbox4Q2m";
    } else if (chain == "Solana") { "Nak" # hex # "9xQ2mSandbox7f3aB4c" } else if (chain == "Ripple") {
      "rNak" # hex # "Sandbox9Q2m";
    } else if (chain == "Cardano") { "addr1q" # hex # "nak0sandbox7f3a" } else if (chain == "TON") {
      "EQNak" # hex # "Sandbox9Q2m";
    } else if (chain == "Monero") { "4Nak" # hex # "Sandbox9Q2m7f3a" } else if (chain == "Sui") {
      "0xnak" # hex # "sandbox7f3a";
    } else if (chain == "Doge" or chain == "Litecoin") { "DNak" # hex # "Sandbox9Q2m" } else {
      "0x" # hex # "Nak0Sandbox7f3aB4c9D2e"
    };
  };

  /// List orders, optionally filtered by router status.
  public func listOrders(state : State, filter : ?Types.RouterStatus) : [Types.OrderSummary] {
    let all = state.orders.values().map(func(o) = toSummary(o)).toArray();
    let filtered = switch (filter) {
      case (null) { all };
      case (?f) { all.filter(func(s) = sameStatus(s.routerStatus, f)) };
    };
    filtered.sort(func(a, b) = Nat.compare(b.id, a.id));
  };

  func sameStatus(a : Types.RouterStatus, b : Types.RouterStatus) : Bool {
    switch (a, b) {
      case (#awaitingDeposit, #awaitingDeposit) { true };
      case (#swapping, #swapping) { true };
      case (#payoutPending, #payoutPending) { true };
      case (#completed, #completed) { true };
      case (#refunded, #refunded) { true };
      case (#needsReview(x), #needsReview(y)) { x == y };
      case (_, _) { false };
    };
  };

  func toSummary(o : Types.Order) : Types.OrderSummary {
    {
      id = o.id;
      recipient = o.recipient;
      tokenSymbol = o.tokenSymbol;
      tokenChain = o.tokenChain;
      tokenAmount = o.tokenAmount;
      routeType = o.routeType;
      houdiniStatus = o.houdiniStatus;
      routerStatus = o.routerStatus;
      createdAt = o.createdAt;
      updatedAt = o.updatedAt;
    };
  };

  /// Fetch a single order by id.
  public func getOrder(state : State, id : Types.OrderId) : ?Types.Order {
    state.orders.get(id);
  };

  // ---------------------------------------------------------------------------
  // Houdini leg (leg 1)
  // ---------------------------------------------------------------------------

  /// Advance the Houdini leg one step (WAITING → CONFIRMING → EXCHANGING →
  /// [ANONYMIZING] → COMPLETED), crediting ICP on COMPLETED.
  public func advanceHoudini(state : State, id : Types.OrderId) : () {
    let order = state.orders.get(id) ?? Runtime.trap("Order not found");
    let now = Time.now();
    let elapsed = (now - order.createdAt) / 1_000_000_000;
    if (elapsed > HOUDINI_TTL_SECONDS and order.houdiniStatus != #completed) {
      state.orders.add(id, { order with houdiniStatus = #expired; updatedAt = now });
      return;
    };
    switch (order.houdiniStatus) {
      case (#waiting) {
        state.orders.add(id, { order with houdiniStatus = #confirming; updatedAt = now });
      };
      case (#confirming) {
        state.orders.add(id, { order with houdiniStatus = #exchanging; updatedAt = now });
      };
      case (#exchanging) {
        if (order.routeType == #private_) {
          state.orders.add(id, { order with houdiniStatus = #anonymizing; updatedAt = now });
        } else {
          completeHoudini(state, order, now);
        };
      };
      case (#anonymizing) {
        completeHoudini(state, order, now);
      };
      case (#completed) {};
      case (#expired) {};
      case (#failed) {};
      case (#refunded) {};
    };
  };

  func completeHoudini(state : State, order : Types.Order, now : Int) : () {
    let icpOut = quote(state, order.tokenSymbol, order.tokenAmount, order.routeType).houdini.icpOut;
    let account = order.depositAccountId;
    let current = state.sandboxIcpBalances.get(account) ?? 0;
    state.sandboxIcpBalances.add(account, current + icpOut);
    state.sandboxAccountOwners.add(account, order.recipient);
    state.orders.add(order.id, {
      order with
      houdiniStatus = #completed;
      icpIn = ?icpOut;
      updatedAt = now;
    });
  };

  /// Simulate the user having sent the source token ("I've sent it").
  public func simulateDeposit(state : State, id : Types.OrderId) : () {
    let order = state.orders.get(id) ?? Runtime.trap("Order not found");
    if (order.houdiniStatus == #waiting) {
      if (state.testToggles.value.houdiniLegFailsNextOrder) {
        state.testToggles.value := { state.testToggles.value with houdiniLegFailsNextOrder = false };
        state.orders.add(id, { order with houdiniStatus = #failed; updatedAt = Time.now() });
      } else {
        state.orders.add(id, { order with houdiniStatus = #confirming; updatedAt = Time.now() });
      };
    };
  };

  /// Advance in-progress Houdini legs a few seconds per step, and settle a
  /// FAILED leg to REFUNDED. Driven by a dedicated short timer in main.mo.
  public func processHoudini(state : State) : () {
    let ids = state.orders.keys().toArray();
    for (id in ids.values()) {
      switch (state.orders.get(id)) {
        case (?order) {
          switch (order.houdiniStatus) {
            case (#confirming or #exchanging or #anonymizing) { advanceHoudini(state, id) };
            case (#failed) {
              state.orders.add(id, { order with houdiniStatus = #refunded; updatedAt = Time.now() });
            };
            case (_) {};
          };
        };
        case (null) {};
      };
    };
  };

  // ---------------------------------------------------------------------------
  // Router leg (leg 2)
  // ---------------------------------------------------------------------------

  /// Advance a single order through the router pipeline.
  public func processOrder(state : State, id : Types.OrderId) : async Types.ProcessResult {
    let order = state.orders.get(id) ?? Runtime.trap("Order not found");
    if (order.routerStatus == #completed or order.routerStatus == #refunded) {
      return #noop;
    };
    if (state.busy.locked) {
      return #busy;
    };
    state.busy.locked := true;
    let result = advanceRouter(state, order);
    state.busy.locked := false;
    result;
  };

  func advanceRouter(state : State, order : Types.Order) : Types.ProcessResult {
    let now = Time.now();
    switch (order.routerStatus) {
      case (#awaitingDeposit) {
        if (order.houdiniStatus != #completed) { return #noop };
        let account = order.depositAccountId;
        let balance = state.sandboxIcpBalances.get(account) ?? 0;
        if (balance == 0) { return #noop };
        state.orders.add(order.id, { order with routerStatus = #swapping; updatedAt = now });
        #advanced(#swapping);
      };
      case (#swapping) {
        let account = order.depositAccountId;
        let balance = state.sandboxIcpBalances.get(account) ?? 0;
        if (balance == 0) { return #noop };
        let icpAfterFees = if (balance > ICP_FEE) { balance - ICP_FEE } else { 0 };
        let pool = state.sandboxPool.value;
        let probeOut = poolQuote(pool, PROBE_ICP, true);
        let spot = if (pool.icp == 0) { 0 } else { pool.nak / pool.icp };
        let impact = if (probeOut == 0 or spot == 0) { 0 } else { bpsOf(absDiff(probeOut, spot), spot) };
        let reason : ?Types.RefundReason = if (icpAfterFees < state.config.value.minOrderIcp) {
          ?#tooSmall;
        } else if (icpAfterFees > state.config.value.maxOrderIcp) { ?#tooLarge } else if (impact > state.config.value.maxImpactBps) {
          ?#priceImpact({ bps = impact });
        } else { null };
        switch (reason) {
          case (?r) { refundOrder(state, order, balance, r, now) };
          case (null) {
            if (state.testToggles.value.poolWithdrawFailsNextSwap) {
              state.testToggles.value := { state.testToggles.value with poolWithdrawFailsNextSwap = false };
              refundOrder(state, order, balance, #swapFailed("Pool withdraw failed"), now);
            } else {
              let (newPool, out) = poolSwap(pool, icpAfterFees, true);
              state.sandboxPool.value := newPool;
              state.sandboxIcpBalances.add(account, 0);
              state.orders.add(order.id, {
                order with
                routerStatus = #payoutPending;
                nakOut = ?out;
                updatedAt = now;
              });
              #advanced(#payoutPending);
            };
          };
        };
      };
      case (#payoutPending) {
        let account = order.depositAccountId;
        let nakOut = order.nakOut ?? 0;
        if (state.testToggles.value.failNextNakPayout) {
          state.testToggles.value := { state.testToggles.value with failNextNakPayout = false };
          let balance = state.sandboxIcpBalances.get(account) ?? 0;
          refundOrder(state, order, balance, #swapFailed("NAK payout failed"), now);
        } else {
          let current = state.sandboxNakBalances.get(order.recipient.toText()) ?? 0;
          state.sandboxNakBalances.add(order.recipient.toText(), current + nakOut);
          state.sandboxAccountOwners.add(order.recipient.toText(), order.recipient);
          state.sandboxRouterMain.value := {
            icp = state.sandboxRouterMain.value.icp;
            nak = state.sandboxRouterMain.value.nak + NAK_FEE;
          };
          state.orders.add(order.id, {
            order with
            routerStatus = #completed;
            block = ?order.id;
            updatedAt = now;
          });
          #advanced(#completed);
        };
      };
      case (#completed) { #noop };
      case (#refunded) { #noop };
      case (#needsReview(_)) { #noop };
    };
  };

  func refundOrder(state : State, order : Types.Order, amount : Nat, reason : Types.RefundReason, now : Int) : Types.ProcessResult {
    let current = state.sandboxIcpBalances.get(order.recipient.toText()) ?? 0;
    state.sandboxIcpBalances.add(order.recipient.toText(), current + amount);
    state.sandboxAccountOwners.add(order.recipient.toText(), order.recipient);
    state.sandboxIcpBalances.add(order.depositAccountId, 0);
    state.orders.add(order.id, {
      order with
      routerStatus = #refunded;
      refundReason = ?reason;
      block = ?order.id;
      updatedAt = now;
    });
    #advanced(#refunded);
  };

  /// Advance all eligible orders (background timer entry point).
  public func processEligible(state : State) : async () {
    let ids = state.orders.keys().toArray();
    for (id in ids.values()) {
      switch (state.orders.get(id)) {
        case (?order) {
          let elapsed = (Time.now() - order.createdAt) / 1_000_000_000;
          if (order.houdiniStatus == #waiting and elapsed > HOUDINI_TTL_SECONDS) {
            state.orders.add(id, { order with houdiniStatus = #expired; updatedAt = Time.now() });
          };
          switch (state.orders.get(id)) {
            case (?updated) {
              if (updated.routerStatus == #awaitingDeposit and updated.houdiniStatus == #completed) {
                ignore await processOrder(state, id);
              } else if (updated.routerStatus == #swapping or updated.routerStatus == #payoutPending) {
                ignore await processOrder(state, id);
              };
            };
            case (null) {};
          };
        };
        case (null) {};
      };
    };
  };

  // ---------------------------------------------------------------------------
  // Config / toggles / balances
  // ---------------------------------------------------------------------------

  /// Read the current config.
  public func getConfig(state : State) : Types.Config {
    state.config.value;
  };

  /// Update the config.
  public func setConfig(state : State, config : Types.Config) : () {
    if (config.slippageBps > BPS_DENOM or config.maxImpactBps > BPS_DENOM) {
      Runtime.trap("Invalid config: bps out of range");
    };
    if (config.minOrderIcp == 0 or config.maxOrderIcp < config.minOrderIcp) {
      Runtime.trap("Invalid config: order bounds");
    };
    state.config.value := config;
  };

  /// Read the sandbox test toggles.
  public func getTestToggles(state : State) : Types.TestToggles {
    state.testToggles.value;
  };

  /// Update the sandbox test toggles.
  public func setTestToggles(state : State, toggles : Types.TestToggles) : () {
    state.testToggles.value := toggles;
  };

  /// Read the sandbox balances snapshot, merging ICP and NAK balances under
  /// each owner principal so a refunded order's ICP is visible.
  public func getSandboxBalances(state : State) : Types.SandboxBalances {
    let byPrincipal = Map.empty<Text, { var icp : Types.Amount; var nak : Types.Amount }>();
    for ((account, nak) in state.sandboxNakBalances.entries()) {
      switch (state.sandboxAccountOwners.get(account)) {
        case (?principal) {
          let key = principal.toText();
          let entry : { var icp : Types.Amount; var nak : Types.Amount } =
            byPrincipal.get(key) ?? ({ var icp = 0; var nak = 0 });
          entry.nak := entry.nak + nak;
          byPrincipal.add(key, entry);
        };
        case (null) {};
      };
    };
    for ((account, icp) in state.sandboxIcpBalances.entries()) {
      switch (state.sandboxAccountOwners.get(account)) {
        case (?principal) {
          let key = principal.toText();
          let entry : { var icp : Types.Amount; var nak : Types.Amount } =
            byPrincipal.get(key) ?? ({ var icp = 0; var nak = 0 });
          entry.icp := entry.icp + icp;
          byPrincipal.add(key, entry);
        };
        case (null) {};
      };
    };
    let users = byPrincipal.entries().map(func((key, bal)) {
      { principal = Principal.fromText(key); icp = bal.icp; nak = bal.nak };
    }).toArray();
    {
      pool = state.sandboxPool.value;
      routerMainIcp = state.sandboxRouterMain.value.icp;
      routerMainNak = state.sandboxRouterMain.value.nak;
      users;
    };
  };

  /// Read the token catalogue.
  public func listTokens(state : State) : [Types.Token] {
    state.tokens.values().toArray();
  };

  /// Update a token's USD price.
  public func setTokenPrice(state : State, symbol : Text, usdMicro : Nat) : () {
    let token = state.tokens.get(symbol) ?? Runtime.trap("Unknown token");
    state.tokens.add(symbol, { token with usdMicro });
  };

  /// Read the ICP USD price.
  public func getIcpPrice(state : State) : Nat {
    state.icpUsdMicro.value;
  };

  /// Update the ICP USD price.
  public func setIcpPrice(state : State, usdMicro : Nat) : () {
    state.icpUsdMicro.value := usdMicro;
  };

  /// Read the simulated NAK balance of a principal.
  public func getNakBalance(state : State, principal : Principal) : Nat {
    state.sandboxNakBalances.get(principal.toText()) ?? 0;
  };

  /// Reset the sandbox to its seeded state.
  public func resetSandbox(state : State) : () {
    state.orders.clear();
    state.nextOrderId.value := 0;
    state.sandboxIcpBalances.clear();
    state.sandboxNakBalances.clear();
    state.sandboxAccountOwners.clear();
    state.sandboxPool.value := { icp = 146_600_000_000; nak = 162_000_000_000_000_000 };
    state.sandboxRouterMain.value := { icp = 0; nak = 0 };
    state.icpUsdMicro.value := 3_000_000;
    state.config.value := {
      slippageBps = 100;
      maxImpactBps = 500;
      minOrderIcp = 10_000_000;
      maxOrderIcp = 5_000_000_000;
      orderTtlSeconds = 7200;
      paused = false;
    };
    state.testToggles.value := {
      failNextNakPayout = false;
      poolWithdrawFailsNextSwap = false;
      houdiniLegFailsNextOrder = false;
    };
    seedTokens(state);
  };

  /// Seed the token catalogue (idempotent).
  public func seedTokens(state : State) : () {
    let seeds : [Types.Token] = [
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
      state.tokens.add(tokenKey(token.symbol, token.chain), token);
    };
  };
};
