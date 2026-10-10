import type { Principal } from "@icp-sdk/core/principal";
import { vi } from "vitest";

import type {
  Config,
  Order,
  OrderSummary,
  ProcessResult,
  Quote,
  SandboxBalances,
  TestToggles,
  Token,
} from "@/backend";
import { HoudiniStatus, RouteType } from "@/backend";

/**
 * A typed local stand-in for the generated backend actor.
 *
 * Every method the app calls is present with the app's own generated types, so a
 * component that calls a method the mock does not implement fails to compile
 * rather than silently passing. Tests override individual methods with
 * `mockResolvedValue`/`mockImplementation`.
 */
export interface MockActor {
  createOrder: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
  getIcpPrice: ReturnType<typeof vi.fn>;
  getNakBalance: ReturnType<typeof vi.fn>;
  getOrder: ReturnType<typeof vi.fn>;
  getQuote: ReturnType<typeof vi.fn>;
  getSandboxBalances: ReturnType<typeof vi.fn>;
  getTestToggles: ReturnType<typeof vi.fn>;
  listOrders: ReturnType<typeof vi.fn>;
  listTokens: ReturnType<typeof vi.fn>;
  processOrder: ReturnType<typeof vi.fn>;
  resetSandbox: ReturnType<typeof vi.fn>;
  setConfig: ReturnType<typeof vi.fn>;
  setIcpPrice: ReturnType<typeof vi.fn>;
  setTestToggles: ReturnType<typeof vi.fn>;
  setTokenPrice: ReturnType<typeof vi.fn>;
  simulateDeposit: ReturnType<typeof vi.fn>;
}

export interface CoreInfraMockState {
  actor: MockActor;
  isFetching: boolean;
}

/** Build a fresh actor mock with every method stubbed to a benign default. */
export function createMockActor(): MockActor {
  return {
    createOrder: vi.fn(),
    getConfig: vi.fn(),
    getIcpPrice: vi.fn(),
    getNakBalance: vi.fn(),
    getOrder: vi.fn(),
    getQuote: vi.fn(),
    getSandboxBalances: vi.fn(),
    getTestToggles: vi.fn(),
    listOrders: vi.fn(),
    listTokens: vi.fn(),
    processOrder: vi.fn(),
    resetSandbox: vi.fn(),
    setConfig: vi.fn(),
    setIcpPrice: vi.fn(),
    setTestToggles: vi.fn(),
    setTokenPrice: vi.fn(),
    simulateDeposit: vi.fn(),
  };
}

/**
 * Mutable state the mocked `@caffeineai/core-infrastructure` module reads.
 * Tests mutate this before rendering; `resetCoreInfraMock` restores defaults.
 */
export const coreInfraMock: CoreInfraMockState = {
  actor: createMockActor(),
  isFetching: false,
};

export function resetCoreInfraMock(): void {
  coreInfraMock.actor = createMockActor();
  coreInfraMock.isFetching = false;
}

/**
 * The module factory passed to `vi.mock("@caffeineai/core-infrastructure", ...)`.
 *
 * The app builds its anonymous actor with `createActorWithConfig(createActor)`
 * (see `hooks/useBackend.ts`), so the mock must expose that factory and resolve
 * it to the typed mock actor. `useActor` is kept because the real package
 * exports it and other code may reference it.
 */
export function coreInfraModule() {
  return {
    createActorWithConfig: async () => coreInfraMock.actor,
    useActor: () => ({
      actor: coreInfraMock.actor,
      isFetching: coreInfraMock.isFetching,
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixture builders — typed against the app's own generated backend types.
// ---------------------------------------------------------------------------

export const SANDBOX_CONFIG: Config = {
  slippageBps: 100n,
  maxOrderIcp: 50_000_000_000n,
  maxImpactBps: 500n,
  orderTtlSeconds: 1800n,
  paused: false,
  minOrderIcp: 10_000_000n,
};

export const SANDBOX_QUOTE: Quote = {
  tokenAmount: 100_000_000n,
  tokenSymbol: "ETH",
  tokenChain: "Ethereum",
  tokenUsdMicro: 3_000_000n,
  icpUsdMicro: 3_000_000n,
  houdini: {
    feeBps: 80n,
    icpOut: 99_200_000n,
    etaSeconds: 300n,
    tokenAmount: 100_000_000n,
    routeType: RouteType.standard,
    tokenSymbol: "ETH",
    tokenChain: "Ethereum",
  },
  router: {
    nakOut: 1_100_000_000n,
    wouldRefund: false,
    icpAfterFees: 99_170_000n,
    verdict: "OK: this order would be swapped.",
    minNakOut: 1_089_000_000n,
    priceImpactBps: 12n,
    icpIn: 99_200_000n,
  },
};

export const SANDBOX_TOGGLES: TestToggles = {
  poolWithdrawFailsNextSwap: false,
  failNextNakPayout: false,
  houdiniLegFailsNextOrder: false,
};

export const SANDBOX_BALANCES: SandboxBalances = {
  pool: { icp: 146_600_000_000n, nak: 162_000_000_000_000_000n },
  routerMainIcp: 0n,
  routerMainNak: 0n,
  users: [],
};

/** The 21 seeded tokens the acceptance criteria name. */
export const SEEDED_TOKENS: Token[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    chain: "Bitcoin",
    usdMicro: 65_000_000_000n,
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    chain: "Ethereum",
    usdMicro: 3_000_000_000n,
  },
  { symbol: "USDT", name: "Tether", chain: "Ethereum", usdMicro: 1_000_000n },
  { symbol: "USDT", name: "Tether", chain: "Tron", usdMicro: 1_000_000n },
  { symbol: "USDT", name: "Tether", chain: "Solana", usdMicro: 1_000_000n },
  { symbol: "USDC", name: "USD Coin", chain: "Ethereum", usdMicro: 1_000_000n },
  { symbol: "USDC", name: "USD Coin", chain: "Base", usdMicro: 1_000_000n },
  { symbol: "USDC", name: "USD Coin", chain: "Solana", usdMicro: 1_000_000n },
  { symbol: "SOL", name: "Solana", chain: "Solana", usdMicro: 150_000_000n },
  { symbol: "BNB", name: "BNB", chain: "BNB Chain", usdMicro: 600_000_000n },
  { symbol: "XRP", name: "XRP", chain: "XRP Ledger", usdMicro: 500_000n },
  { symbol: "DOGE", name: "Dogecoin", chain: "Dogecoin", usdMicro: 150_000n },
  { symbol: "LTC", name: "Litecoin", chain: "Litecoin", usdMicro: 80_000_000n },
  { symbol: "TRX", name: "TRON", chain: "Tron", usdMicro: 150_000n },
  { symbol: "ADA", name: "Cardano", chain: "Cardano", usdMicro: 450_000n },
  {
    symbol: "AVAX",
    name: "Avalanche",
    chain: "Avalanche",
    usdMicro: 35_000_000n,
  },
  { symbol: "POL", name: "Polygon", chain: "Polygon", usdMicro: 500_000n },
  { symbol: "TON", name: "Toncoin", chain: "TON", usdMicro: 5_000_000n },
  { symbol: "XMR", name: "Monero", chain: "Monero", usdMicro: 160_000_000n },
  { symbol: "SUI", name: "Sui", chain: "Sui", usdMicro: 1_000_000n },
  {
    symbol: "ICP",
    name: "Internet Computer",
    chain: "ICP",
    usdMicro: 3_000_000n,
  },
];

export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 0n,
    houdiniStatus: HoudiniStatus.waiting,
    createdAt: 1_700_000_000_000_000_000n,
    depositSubaccount: new Uint8Array(32),
    depositAccountId: "a".repeat(64),
    recipient: { toText: () => "aaaaa-aa" } as unknown as Order["recipient"],
    tokenAmount: 100_000_000n,
    depositAddress: "0xdeadbeef",
    routeType: RouteType.standard,
    tokenSymbol: "ETH",
    updatedAt: 1_700_000_000_000_000_000n,
    tokenChain: "Ethereum",
    routerStatus: { __kind__: "awaitingDeposit", awaitingDeposit: null },
    ...overrides,
  };
}

export function makeOrderSummary(
  overrides: Partial<OrderSummary> = {},
): OrderSummary {
  return {
    id: 0n,
    houdiniStatus: HoudiniStatus.waiting,
    createdAt: 1_700_000_000_000_000_000n,
    recipient: {
      toText: () => "aaaaa-aa",
    } as unknown as OrderSummary["recipient"],
    tokenAmount: 100_000_000n,
    routeType: RouteType.standard,
    tokenSymbol: "ETH",
    updatedAt: 1_700_000_000_000_000_000n,
    tokenChain: "Ethereum",
    routerStatus: { __kind__: "awaitingDeposit", awaitingDeposit: null },
    ...overrides,
  };
}

export const COMPLETED_ROUTER_STATUS = {
  __kind__: "completed",
  completed: null,
} as const;

export const REFUNDED_ROUTER_STATUS = {
  __kind__: "refunded",
  refunded: null,
} as const;

export const NEEDS_REVIEW_ROUTER_STATUS = {
  __kind__: "needsReview",
  needsReview: "pool withdraw failed (test toggle)",
} as const;

export const PROCESS_ADVANCED: ProcessResult = {
  __kind__: "advanced",
  advanced: { __kind__: "swapping", swapping: null },
};
