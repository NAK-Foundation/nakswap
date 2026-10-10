# NAKSwap v2 — any token → ICP (Houdini) → NAK (ICPSwap)

Live version of NAKSwap v2, separate from the Caffeine sandbox app at the repo root.

- `src/router/`: the router canister (Motoko), deployed to mainnet with `relay/scripts/deploy-router.mjs`.
- `relay/`: the Railway service. It serves the swap page at `/`, holds the Houdini key, opens
  router orders and pairs them with Houdini exchanges. Railway root directory: `nakswap-v2/relay`.
- Railway variables: `HOUDINI_API_KEY`, `HOUDINI_API_SECRET` (you set these), `RELAY_IDENTITY_SEED`,
  `ROUTER_CANISTER_ID`, `IC_HOST=https://icp-api.io`. See `relay/.env.example`.

Until `ROUTER_CANISTER_ID` is set the page shows live quotes but swaps stay disabled. Without the
Houdini key it shows a notice instead of tokens. Tests and the local replica setup still run against
mock ledgers, a mock ICPSwap pool and mock Houdini (see below).

## How a swap works

```
 user wallet (ETH, SOL, USDT, …)
        │  sends to Houdini's deposit address
        ▼
 Houdini ── pays ICP ──► router deposit account   (one per order, owned by the router canister)
                               │
                               │  router: sweep → icrc2_approve → depositFromAndSwap
                               ▼
                         ICPSwap NAK/ICP pool
                               │
                               ▼
                    NAK ──► user's principal (PID)
```

The user gives **one** address: their principal. The "account ID" Houdini pays to is
not the user's — it is a subaccount of the router canister, created per order. That is
what lets the second leg happen without the user signing anything after Houdini finishes.

If the swap can't happen safely (too small, too big, price impact, slippage, pool error)
the ICP goes back to the user's principal instead (`refundTo`, defaults to the recipient).

## Mainnet facts this is built against (checked 2026-10-08)

| | |
|-|-|
| NAK ledger | `eig2s-waaaa-aaaam-qbg5a-cai` — 8 decimals, fee 1,000,000 (0.01 NAK), ICRC-1 + ICRC-2 |
| NAK/ICP pool | `d6hdt-qiaaa-aaaag-qm76q-cai` — token0 = NAK, token1 = ICP → ICP→NAK is `zeroForOne = false` |
| Pool depth | ~1,466 ICP / ~162M NAK (~$9.9k TVL). Live quote: 1 ICP → ~84.7k NAK; 50 ICP → ~2.8% impact |
| Pool calls used | `quote`, `depositFromAndSwap` — Candid confirmed against the live pool |
| Houdini | Partner API v2, ICP listed as a chain (`icp`). Key + secret, plus required `x-user-ip` / `x-user-agent` / `x-user-timezone` headers |

## Layout

```
src/common/        Ext.mo (ledger + pool interfaces), Account.mo (subaccounts, account ids)
src/router/        the canister: types, lib/Engine (state machine), lib/Orders, mixins (API), main
src/mocks/         MockLedger (ICP-ledger-style balances, ICRC-1/2 + legacy transfer), MockSwapPool
src/test/          e2e.mo — full flow in the Motoko interpreter
relay/             Node service holding the Houdini key: quotes, order creation, status
scripts/           interp-test.mjs — runs e2e.mo without a replica
```

## Router order lifecycle

```
awaitingDeposit → swapping → payoutPending → completed
                           ↘ refundPending → refunded
awaitingDeposit → expired       (nothing paid within the TTL; admin can reopen)
anything unexpected → needsReview   (funds are never guessed at; admin uses forceRefund)
```

Safety rails:
- One swap at a time (`busy` lock), so balance changes on the router's main account belong to exactly one order. Payouts are computed from balance deltas, not from the pool's return value.
- Price check right before the swap: refund if impact > `maxImpactBps`, otherwise `amountOutMinimum` = quote − `slippageBps` (or the user's `minNakOut` if higher).
- Payouts and refunds use a fixed `created_at_time` + memo, so a retry is deduplicated by the ledger instead of paying twice.
- Only `operators` (the relay) can open orders; `poke` is public but throttled to once per 10 s per order.

## Relay API

| | |
|-|-|
| `POST /api/quote` `{fromId, amount, refundAddress?}` | Houdini routes to ICP, each with the NAK the router would deliver, price impact, and `blocked` if the router would refund |
| `POST /api/orders` `{quoteId, recipient, refundAddress, refundTo?, minNakOut?}` | router order → Houdini exchange (addressTo = deposit account) → linked; returns where to send funds |
| `GET /api/orders/:id` | router stage + Houdini status; pokes the router once Houdini reports COMPLETED |
| `GET /api/tokens?term=` | Houdini token search |

Houdini quotes expire in about a minute, so the UI should create the order right after the user picks a route.

## Run the checks

```bash
mops install                                   # mo:core into .mops/
npm i --no-save motoko@5                       # interpreter, for the e2e run
node --stack-size=50000 scripts/interp-test.mjs   # full flow: 8 scenarios, prints ALL PASSED
cd relay && npm i && npm test                  # relay: mock flow, guards, Houdini request shape
mops check                                     # type-check with your pinned moc
```

The e2e run covers: account-id derivation, happy path, slippage refund, oversize refund,
price-impact refund, payout retry after a ledger error (paid exactly once), pool failure →
needsReview, expiry + reopen, access control. The interpreter can't run `mixin`s or
module-level `async*` calls correctly, so `interp-test.mjs` inlines them into a temporary
copy first; the canister source itself is unchanged.

## Local replica (next step, not run yet)

`icp.yaml` + `mops.toml` define `router`, `mock_icp_ledger`, `mock_nak_ledger`, `mock_pool`.
Order: start a local network, create the four canisters, install the ledgers
(`("ICP", 10_000)`, `("NAK", 1_000_000)`), install the pool with both ledger ids and
`icpIsToken0 = false`, mint NAK + ICP to the pool and call `seed`, install the router with
its `Config` (relay principal in `operators`), mint ICP to the relay principal so the mock
Houdini can "pay", then `cd relay && cp .env.example .env && npm start`.

## Before mainnet

1. Small live test (≈0.2 ICP): confirm ICPSwap's `depositFromAndSwap` accepts ICP pulled via ICRC-2 and what it returns on slippage; confirm a Houdini partner pays an ICP **account id** (not a principal) without a memo.
2. Houdini partner key (partner portal) — the relay only.
3. Decide on a NAKSwap fee (none today).
4. Router config: `maxOrderIcp` / `maxImpactBps` sized to pool depth; consider raising depth before advertising.
5. ICPSwap can queue withdrawals; a swap that lands in `needsReview` with nothing back usually means NAK is in the pool's withdraw queue / unused balance for the router.
6. Switch the canister to the mops migration chain before first mainnet deploy so later upgrades are safe.
