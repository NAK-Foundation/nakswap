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

## NAKSwap fee

1% of the ICP that Houdini delivers to the deposit account (`setFee`, max 5%). The router swaps
`ICP − 1% − 3 ledger fees` for NAK and the 1% stays in its main account. It is counted as
earned only when the swap produces NAK; if the swap is refunded, the user gets the full
amount back and no fee is taken. Earned fees are swept to the fee wallet (default: the admin
principal) once they reach 0.05 ICP, or on demand with `sweepFees`. The relay reads the rate
from `health()`, so quotes and `minNakOut` already account for it.

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
| `GET /api/orders/:id?key=` | router stage + Houdini status; pokes the router once Houdini reports COMPLETED |
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
1% fee accrual and sweep, no fee on refunds, price-impact refund, payout retry after a ledger error (paid exactly once), pool failure →
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
3. NAKSwap fee: 1%, see above.
4. Router config: `maxOrderIcp` / `maxImpactBps` sized to pool depth; consider raising depth before advertising.
5. ICPSwap can queue withdrawals; a swap that lands in `needsReview` with nothing back usually means NAK is in the pool's withdraw queue / unused balance for the router.
6. Switch the canister to the mops migration chain before first mainnet deploy so later upgrades are safe.

## Operating the live router

`relay/scripts/router-admin.mjs`, signed with the controller key (`nakswap-router-controller.pem`):

```bash
cd relay
export CONTROLLER_PEM=/path/to/nakswap-router-controller.pem
node scripts/router-admin.mjs health                 # cycles, freezing threshold, config
node scripts/router-admin.mjs set max-order-icp 30   # any limit; ICP fields take ICP
node scripts/router-admin.mjs pause | unpause
node scripts/router-admin.mjs freezing-days 90
node scripts/router-admin.mjs fees                   # fee rate, wallet, accrued, paid so far
node scripts/router-admin.mjs set-fee 1 <principal>  # fee in % (max 5) and the wallet it goes to
node scripts/router-admin.mjs sweep-fees             # send accrued fees now
```

Admin calls accept the configured admin principal or any canister controller.

Cycle safeguards (`src/router/lib/Guard.mo`):
- below 0.5T cycles the router stops taking orders and starting swaps; ICP that arrives waits in
  its deposit account, untouched, until the canister is topped up
- below 0.15T it also holds payouts and refunds
- the freezing threshold is 90 days of idle burn, so if cycles keep falling the IC freezes the
  canister with its state intact instead of deleting it. Top up from the NNS app (Canisters tab)
  or any cycles wallet and it resumes on its own.

Upgrades: `MODE=upgrade CANISTER_ID=bkyfl-uyaaa-aaaab-qhl5q-cai` with `scripts/deploy-router.mjs`. The
script stops the canister first (in-flight swaps and payouts finish), installs, and starts it again.

### Resolving an order in "needs review"

The router parks an order in `needsReview` whenever it can't be sure whose money is where:
balances moved more than the swap explains, ICPSwap kept the funds, or a ledger kept refusing a
payout for an hour. Nothing is paid automatically after that; the admin decides.

```bash
node scripts/router-admin.mjs orders                      # find it and read the reason
node scripts/router-admin.mjs pool-unused                 # did ICPSwap keep anything for us?
node scripts/router-admin.mjs pool-withdraw icp 1.25      # pull it back to the router (or nak)
node scripts/router-admin.mjs force-payout <id> <NAK>     # pay the user NAK from the router
node scripts/router-admin.mjs force-refund <id> <ICP> main|deposit   # or refund ICP instead
node scripts/router-admin.mjs recover <id> <principal>    # ICP in a finished/deleted order's deposit account
```

Guards: `force-refund` from main can't touch the fees owed to the fee wallet and is capped by
what's there; from a deposit it's capped by the deposit; it's refused when a NAK payout may
already have gone out ("payout …" reasons: check the NAK ledger first). `force-payout` is capped
by the router's NAK balance.

## User privacy

What is and isn't private: everything on the ICP and NAK ledgers is public, so the final NAK
payout to a principal is visible to anyone. What NAKSwap does to keep the rest unlinkable:
- **Private route**: Houdini's private route uses two separate swaps, so the sending wallet
  isn't linked on-chain to the ICP. The page remembers the visitor's route choice.
- **Unlinkable deposit accounts**: each order's deposit subaccount is a keyed hash of the
  order id under a random secret the router fetched from the IC (`raw_rand`). Outsiders can't
  enumerate the router's deposit accounts or match one to an order number.
- **No order numbers on chain**: sweeps, approvals, payouts and refunds carry no memo.
- **Forgetting**: 30 days after an order finishes, the router drops its Houdini order id (the
  link back to the sending wallet). Orders never paired with Houdini are deleted after 15 min.
  `recoverDeposit` (admin) can still return ICP that lands in a deleted order's account.
- **Relay**: order lookups need the order key, sent in a header (never in URLs or logs); logs
  hold only order numbers; fonts are self-hosted, so pages make no third-party calls except
  token icons. Houdini requires the visitor's IP, user agent and timezone on each request
  (compliance headers); the relay passes them through and stores none of them.
- **Tip for users**: receive into a fresh principal if you don't want the NAK tied to your
  main wallet.

## Abuse and cycle-drain protection

Router (`src/router/main.mo`, `lib/Guard.mo`):
- `inspect` ingress filter: every update call must come from the relay (operator), the admin
  or a controller, with an argument under 2 KB. Everything else, including query methods
  called as updates, is rejected before consensus, so it costs the canister nothing.
- `poke`, `getOrder`, `activeOrderIds` are operator/admin only (order ids count up, so a
  public `getOrder` would expose every user's principal). `health`, `getConfig`, `feeStatus`
  stay public queries, which are free for the canister.
- At most 150 open orders. The worker pays out and refunds first, then checks each waiting
  deposit at most once a minute, least recently checked first, 10 per tick.
- Orders the relay never paired with a Houdini exchange are deleted after 15 minutes.
- Balance sanity check after every swap: more NAK than quoted (+2%) or more ICP back than
  deposited parks the order for review instead of paying someone else's funds.
- Approvals to the pool expire after 5 minutes; payouts/refunds carry a per-order memo so two
  identical transfers are never deduplicated into one; a payout the ledger keeps rejecting is
  parked after an hour instead of retrying forever.
- An order interrupted mid-swap stays visible to the worker and is parked for review.
- The relay may poke an order at most every 5 s.
- `setConfig` rejects out-of-range values and can't change the ledgers, the pool, the ledger
  fees, or make the router its own admin/operator/fee wallet;
  `attachHoudini` is set-once; the router can't be its own recipient.

Relay (`relay/src/app.js`, `server.js`):
- Client IP from Railway's `X-Real-IP` (the left end of `X-Forwarded-For` is client-controlled).
- Orders: 5 per IP per 10 min, 150 per hour overall (`ORDER_LIMIT_PER_HOUR` on Railway to change it). Quotes 30/min per IP, cached 20 s to save
  the Houdini quota. Limiter memory is bounded.
- Order links are `id-key`, where the key is an HMAC of the id under the relay seed; without
  the key `/api/orders/:id` answers 404. One router poke per order per 15 s.
- Input validation on every field (strings only, plain decimal amounts), JSON only, 8 KB body
  cap, header/request timeouts, 15 s timeouts on outbound calls, no CORS, CSP that allows only
  the page's own script (by hash) and Houdini's token icons, frame/sniffing/referrer headers.
- Orders only against quotes the relay issued in the last 3 minutes, one order per quote, never
  on a route marked unavailable. The relay sets the order's guaranteed minimum NAK (quote −6%);
  below that the router refunds ICP instead of filling.
- Houdini's exchange must be ICP paid to this order's deposit account, and the router must
  confirm the pairing, before the user is shown a deposit address.
- A malformed request can't crash the process; internal error text never reaches visitors;
  mock Houdini refuses to start against mainnet. Optional `ORDER_KEY_SECRET` separates order
  links from the operator key.
