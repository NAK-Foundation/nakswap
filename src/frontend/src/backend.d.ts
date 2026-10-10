import type { Principal } from "@icp-sdk/core/principal";
export interface Some<T> {
    __kind__: "Some";
    value: T;
}
export interface None {
    __kind__: "None";
}
export type Option<T> = Some<T> | None;
export type AccountId = string;
export type Amount = bigint;
export type BlockIndex = bigint;
export type Bps = bigint;
export interface Cell {
    value: Value;
    name: string;
}
export interface Config {
    slippageBps: Bps;
    maxOrderIcp: Amount;
    maxImpactBps: Bps;
    orderTtlSeconds: bigint;
    paused: boolean;
    minOrderIcp: Amount;
}
export interface HoudiniLeg {
    feeBps: Bps;
    icpOut: Amount;
    etaSeconds: bigint;
    tokenAmount: bigint;
    routeType: RouteType;
    tokenSymbol: string;
    tokenChain: string;
}
export interface Order {
    id: OrderId;
    nakOut?: Amount;
    refundReason?: RefundReason;
    houdiniStatus: HoudiniStatus;
    createdAt: Timestamp;
    depositSubaccount: Uint8Array;
    depositAccountId: AccountId;
    recipient: Principal;
    tokenAmount: bigint;
    depositAddress: string;
    routeType: RouteType;
    tokenSymbol: string;
    updatedAt: Timestamp;
    refundAddress?: string;
    block?: BlockIndex;
    icpIn?: Amount;
    tokenChain: string;
    routerStatus: RouterStatus;
}
export type OrderId = bigint;
export interface OrderSummary {
    id: OrderId;
    houdiniStatus: HoudiniStatus;
    createdAt: Timestamp;
    recipient: Principal;
    tokenAmount: bigint;
    routeType: RouteType;
    tokenSymbol: string;
    updatedAt: Timestamp;
    tokenChain: string;
    routerStatus: RouterStatus;
}
export interface PoolReserves {
    icp: Amount;
    nak: Amount;
}
export type ProcessResult = {
    __kind__: "advanced";
    advanced: RouterStatus;
} | {
    __kind__: "busy";
    busy: null;
} | {
    __kind__: "noop";
    noop: null;
};
export interface Quote {
    tokenAmount: bigint;
    tokenSymbol: string;
    tokenChain: string;
    tokenUsdMicro: bigint;
    icpUsdMicro: bigint;
    router: RouterLeg;
    houdini: HoudiniLeg;
}
export type RefundReason = {
    __kind__: "admin";
    admin: null;
} | {
    __kind__: "priceImpact";
    priceImpact: {
        bps: Bps;
    };
} | {
    __kind__: "tooLarge";
    tooLarge: null;
} | {
    __kind__: "tooSmall";
    tooSmall: null;
} | {
    __kind__: "swapFailed";
    swapFailed: string;
};
export interface Result {
    hasMore: boolean;
    rows: Array<Array<Cell>>;
}
export interface RouterLeg {
    nakOut: Amount;
    wouldRefund: boolean;
    icpAfterFees: Amount;
    verdict: string;
    minNakOut: Amount;
    priceImpactBps: Bps;
    icpIn: Amount;
}
export type RouterStatus = {
    __kind__: "payoutPending";
    payoutPending: null;
} | {
    __kind__: "completed";
    completed: null;
} | {
    __kind__: "refunded";
    refunded: null;
} | {
    __kind__: "awaitingDeposit";
    awaitingDeposit: null;
} | {
    __kind__: "swapping";
    swapping: null;
} | {
    __kind__: "needsReview";
    needsReview: string;
};
export interface SandboxBalances {
    pool: PoolReserves;
    routerMainIcp: Amount;
    routerMainNak: Amount;
    users: Array<{
        icp: Amount;
        nak: Amount;
        principal: Principal;
    }>;
}
export interface TestToggles {
    poolWithdrawFailsNextSwap: boolean;
    failNextNakPayout: boolean;
    houdiniLegFailsNextOrder: boolean;
}
export type Timestamp = bigint;
export interface Token {
    chain: string;
    name: string;
    usdMicro: bigint;
    symbol: string;
}
export type Value = {
    __kind__: "int";
    int: bigint;
} | {
    __kind__: "nat";
    nat: bigint;
} | {
    __kind__: "float";
    float: number;
} | {
    __kind__: "bool";
    bool: boolean;
} | {
    __kind__: "null";
    null: null;
} | {
    __kind__: "text";
    text: string;
};
export enum HoudiniStatus {
    exchanging = "exchanging",
    expired = "expired",
    completed = "completed",
    refunded = "refunded",
    anonymizing = "anonymizing",
    waiting = "waiting",
    confirming = "confirming",
    failed = "failed"
}
export enum RouteType {
    private = "private",
    standard = "standard"
}
export interface backendInterface {
    /**
     * / Create a new order; returns the order id.
     */
    createOrder(recipient: Principal, tokenSymbol: string, tokenAmount: bigint, routeType: RouteType, refundAddress: string | null): Promise<OrderId>;
    execute(qJson: string): Promise<Result>;
    /**
     * / Static Markdown documentation of the public backend API.
     */
    getApiDoc(): Promise<string>;
    /**
     * / Read the current config.
     */
    getConfig(): Promise<Config>;
    /**
     * / Read the ICP USD price.
     */
    getIcpPrice(): Promise<bigint>;
    /**
     * / Read the simulated NAK balance of a principal.
     */
    getNakBalance(principal: Principal): Promise<bigint>;
    /**
     * / Fetch a single order by id.
     */
    getOrder(id: OrderId): Promise<Order | null>;
    /**
     * / Two-leg quote preview for a prospective order.
     */
    getQuote(tokenSymbol: string, tokenAmount: bigint, routeType: RouteType): Promise<Quote>;
    /**
     * / Read the sandbox balances snapshot.
     */
    getSandboxBalances(): Promise<SandboxBalances>;
    /**
     * / Read the sandbox test toggles.
     */
    getTestToggles(): Promise<TestToggles>;
    /**
     * / List orders, optionally filtered by router status.
     */
    listOrders(filter: RouterStatus | null): Promise<Array<OrderSummary>>;
    /**
     * / Read the token catalogue.
     */
    listTokens(): Promise<Array<Token>>;
    /**
     * / Advance a single order through the router pipeline.
     */
    processOrder(id: OrderId): Promise<ProcessResult>;
    /**
     * / Reset the sandbox to its seeded state.
     */
    resetSandbox(): Promise<void>;
    schema(): Promise<string>;
    /**
     * / Update the config.
     */
    setConfig(config: Config): Promise<void>;
    /**
     * / Update the ICP USD price.
     */
    setIcpPrice(usdMicro: bigint): Promise<void>;
    /**
     * / Update the sandbox test toggles.
     */
    setTestToggles(toggles: TestToggles): Promise<void>;
    /**
     * / Update a token's USD price.
     */
    setTokenPrice(symbol_: string, usdMicro: bigint): Promise<void>;
    /**
     * / Simulate the user having sent the source token ("I've sent it").
     */
    simulateDeposit(id: OrderId): Promise<void>;
}
