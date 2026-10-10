// Candid bindings, hand-written to match src/router (see the generated .did) and the
// ICPSwap SwapPool / ICP ledger calls the relay makes.
import { IDL } from '@icp-sdk/core/candid';

export const routerIdl = ({ IDL }) => {
  const RefundReason = IDL.Variant({
    tooSmall: IDL.Null,
    tooLarge: IDL.Null,
    priceImpact: IDL.Record({ bps: IDL.Nat }),
    swapFailed: IDL.Text,
    admin: IDL.Null,
  });
  const Status = IDL.Variant({
    awaitingDeposit: IDL.Null,
    swapping: IDL.Record({ icpIn: IDL.Nat, startedAt: IDL.Int }),
    payoutPending: IDL.Record({ icpIn: IDL.Nat, nakAmount: IDL.Nat, createdAtTime: IDL.Nat64 }),
    refundPending: IDL.Record({
      icpAmount: IDL.Nat,
      fromDeposit: IDL.Bool,
      reason: RefundReason,
      createdAtTime: IDL.Nat64,
    }),
    completed: IDL.Record({ icpIn: IDL.Nat, nakOut: IDL.Nat, block: IDL.Nat }),
    refunded: IDL.Record({ icpAmount: IDL.Nat, reason: RefundReason, block: IDL.Nat }),
    expired: IDL.Null,
    needsReview: IDL.Text,
  });
  const OrderView = IDL.Record({
    id: IDL.Nat,
    recipient: IDL.Principal,
    refundTo: IDL.Principal,
    minNakOut: IDL.Nat,
    createdAt: IDL.Int,
    depositAccountId: IDL.Text,
    depositSubaccount: IDL.Vec(IDL.Nat8),
    houdiniId: IDL.Opt(IDL.Text),
    status: Status,
  });
  const CreateOrderArgs = IDL.Record({
    recipient: IDL.Principal,
    refundTo: IDL.Opt(IDL.Principal),
    minNakOut: IDL.Opt(IDL.Nat),
  });
  const CreateOrderError = IDL.Variant({
    notAuthorized: IDL.Null,
    paused: IDL.Null,
    anonymousRecipient: IDL.Null,
    invalidRecipient: IDL.Null,
    tooManyOpenOrders: IDL.Null,
  });
  const PokeResult = IDL.Variant({
    processed: Status,
    busy: IDL.Null,
    tooSoon: IDL.Null,
    notFound: IDL.Null,
    notAuthorized: IDL.Null,
  });
  const Config = IDL.Record({
    admin: IDL.Principal,
    operators: IDL.Vec(IDL.Principal),
    icpLedger: IDL.Principal,
    nakLedger: IDL.Principal,
    pool: IDL.Principal,
    icpIsToken0: IDL.Bool,
    icpFee: IDL.Nat,
    nakFee: IDL.Nat,
    slippageBps: IDL.Nat,
    maxImpactBps: IDL.Nat,
    minOrderIcp: IDL.Nat,
    maxOrderIcp: IDL.Nat,
    orderTtlSeconds: IDL.Nat,
    paused: IDL.Bool,
  });
  return IDL.Service({
    createOrder: IDL.Func(
      [CreateOrderArgs],
      [IDL.Variant({ ok: OrderView, err: CreateOrderError })],
      [],
    ),
    attachHoudini: IDL.Func([IDL.Nat, IDL.Text], [IDL.Bool], []),
    cancelUnfunded: IDL.Func([IDL.Nat], [IDL.Bool], []),
    getOrder: IDL.Func([IDL.Nat], [IDL.Opt(OrderView)], ['query']),
    // Admin-only (used by scripts/router-admin.mjs, never by the relay itself).
    listOrders: IDL.Func([IDL.Nat, IDL.Nat], [IDL.Vec(OrderView)], ['query']),
    forceRefund: IDL.Func([IDL.Nat, IDL.Nat, IDL.Bool], [IDL.Opt(Status)], []),
    forcePayout: IDL.Func([IDL.Nat, IDL.Nat, IDL.Bool], [IDL.Opt(Status)], []),
    reopen: IDL.Func([IDL.Nat], [IDL.Opt(Status)], []),
    poke: IDL.Func([IDL.Nat], [PokeResult], []),
    getConfig: IDL.Func([], [Config], ['query']),
    health: IDL.Func(
      [],
      [
        IDL.Record({
          cycles: IDL.Nat,
          lowCyclesThreshold: IDL.Nat,
          acceptingOrders: IDL.Bool,
          paused: IDL.Bool,
          activeOrders: IDL.Nat,
          nextOrderId: IDL.Nat,
          // opt so the relay keeps decoding health() from a router built before the fee
          feeBps: IDL.Opt(IDL.Nat),
          helpers: IDL.Opt(IDL.Nat),
        }),
      ],
      ['query'],
    ),
    setConfig: IDL.Func([Config], [IDL.Bool], []),
    setPaused: IDL.Func([IDL.Bool], [IDL.Bool], []),
    // Public totals for the stats strip (completed swaps only).
    publicStats: IDL.Func(
      [],
      [IDL.Record({ swaps: IDL.Nat, icpSwapped: IDL.Nat, nakDelivered: IDL.Nat, lateWatched: IDL.Nat })],
      ['query'],
    ),
  });
};

export const poolIdl = ({ IDL }) => {
  const PoolError = IDL.Variant({
    CommonError: IDL.Null,
    InsufficientFunds: IDL.Null,
    InternalError: IDL.Text,
    UnsupportedToken: IDL.Text,
  });
  const SwapArgs = IDL.Record({ amountIn: IDL.Text, zeroForOne: IDL.Bool, amountOutMinimum: IDL.Text });
  return IDL.Service({
    quote: IDL.Func([SwapArgs], [IDL.Variant({ ok: IDL.Nat, err: PoolError })], ['query']),
  });
};

// ICP ledger: `icrc1_balance_of` (to see a direct ICP payment land in an order's deposit
// account) and the legacy `transfer`, used only by the mock Houdini on a local replica.
export const icpLedgerIdl = ({ IDL }) => {
  const Tokens = IDL.Record({ e8s: IDL.Nat64 });
  const TransferError = IDL.Variant({
    BadFee: IDL.Record({ expected_fee: Tokens }),
    InsufficientFunds: IDL.Record({ balance: Tokens }),
    TxTooOld: IDL.Record({ allowed_window_nanos: IDL.Nat64 }),
    TxCreatedInFuture: IDL.Null,
    TxDuplicate: IDL.Record({ duplicate_of: IDL.Nat64 }),
  });
  return IDL.Service({
    icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ['query']),
    transfer: IDL.Func(
      [
        IDL.Record({
          memo: IDL.Nat64,
          amount: Tokens,
          fee: Tokens,
          from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
          to: IDL.Vec(IDL.Nat8),
          created_at_time: IDL.Opt(IDL.Record({ timestamp_nanos: IDL.Nat64 })),
        }),
      ],
      [IDL.Variant({ Ok: IDL.Nat64, Err: TransferError })],
      [],
    ),
  });
};

export { IDL };
