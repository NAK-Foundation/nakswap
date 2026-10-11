/** Token symbols used across the swap lab. */
export const ICP_SYMBOL = "ICP";
export const NAK_SYMBOL = "NAK";

/** Ledger decimals: ICP uses e8s (8), NAK uses 8 decimals. */
export const ICP_DECIMALS = 8;
export const NAK_DECIMALS = 8;

/** e8s / 10^8 scaling factor. */
export const E8S = 100_000_000n;

/** Account ids are 64 hex characters. */
export const ACCOUNT_ID_HEX_LENGTH = 64;

/** The well-known anonymous principal, which cannot receive a swap payout. */
export const ANONYMOUS_PRINCIPAL = "2vxsx-fae";

/** Route type labels and descriptors for the two-leg swap. */
export const ROUTE_LABELS = {
  standard: "Standard",
  private: "Private",
} as const;

export const ROUTE_DESCRIPTIONS = {
  standard: "~0.8% Houdini fee · faster",
  private: "~1.5% Houdini fee · slower",
} as const;

/** Deposit addresses expire 30 minutes after an order is created. */
export const DEPOSIT_TTL_SECONDS = 1800;

/** Ledger fees charged by the NAKSwap router leg. */
export const ROUTER_ICP_FEES = 3n * 10_000n; // 3 ICP ledger fees in
export const ROUTER_NAK_FEES = 2n * 1_000_000n; // 2 NAK fees out

/** Route paths for the app shell. */
export const ROUTES = {
  swap: "/",
  orders: "/orders",
  orderDetail: "/orders/$id",
  admin: "/admin",
} as const;
