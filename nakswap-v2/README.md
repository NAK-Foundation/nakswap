# NAKSwap v2 — any token → ICP (Houdini) → NAK (ICPSwap)

Live version of NAKSwap v2, separate from the Caffeine sandbox app at the repo root.

- `src/router/`: the router canister (Motoko), deployed to mainnet with `relay/scripts/deploy-router.mjs`.
- `relay/`: the Railway service. It serves the swap page at `/`, holds the Houdini key, opens
  router orders and pairs them with Houdini exchanges. Railway root directory: `nakswap-v2/relay`.
- Railway variables: `HOUDINI_API_KEY`, `HOUDINI_API_SECRET` (you set these), `RELAY_IDENTITY_SEED`,
  `ROUTER_CANISTER_ID`, `IC_HOST=https://icp-api.io`. See `relay/.env.example`.

**Deploys are pinned.** The Railway relay service is pinned to one commit, so a push to
`nakswap-v2-live` does **not** change the live site (someone with only GitHub access can't
ship a page). To release: push, run `npm test` in `relay/`, then point the service at the new
commit (Railway → relay → Settings → Source, or the Railway tool `connect-service-source`
with `commitSha`). Check the page and run `scripts/monitor.mjs` afterwards. The monitor's
page check compares the live site with the checkout, so run it from the deployed commit.
The relay runs with a 1 vCPU / 1 GB limit (it uses ~0.03 vCPU / ~150 MB).

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

### Paying with ICP directly

Visitors who already hold ICP pick "ICP, pay directly" in the token list. There is no
Houdini leg: the relay opens a router order, marks it with `attachHoudini(id, "icp-direct")`
(so the router keeps it for its full window instead of dropping it as unpaired), and shows the
order's deposit account twice: as an ICP account ID (NNS app, exchanges) and as an ICRC-1
textual account (Plug, Oisy). Everything after that is the normal router flow: same fee,
a guaranteed minimum of quote −3% (no Houdini leg to allow for), same refunds to the
principal, same price guards.

- Window: 45 minutes to pay. The relay then cancels an unpaid direct order (`cancelUnfunded`)
  to free its open-order slot; the router's own 2-hour TTL is the backstop.
- The relay watches the deposit account (a free ledger query) while the visitor's page is
  open and pokes the router as soon as ICP lands, so the swap starts within seconds.
- ICP sent after the swap has started stays in that order's deposit account; recover it with
  `router-admin.mjs recover` (`recoverDeposit`).

### Late deposits

An expired order (direct or Houdini) is not forgotten, and neither is a finished one: the
router re-checks the deposit account of expired, completed and refunded orders about every 10
minutes for 3 days after the order's window closed, most overdue first, 10 checks per tick, at
most 3,000 orders watched. A finished order is skipped while any of its NAKSwap fee is still
in its account. ICP that turns up (more than two ledger fees) moves the order back to
`awaitingDeposit`, and the worker swaps it, or refunds it if it is now too small, too big, or
below the order's guaranteed minimum. This covers late Houdini deliveries, direct payments
after the window, and a second payment (e.g. the real one after a too-small test).
`router-admin.mjs late-check` (or the dashboard's Run recovery) checks now. Orders in review
aren't watched (an admin resolves them).

### Price guard

The worker samples the pool's marginal price every tick and keeps a slow moving average. A
swap whose live price is more than 3% worse than that average waits for a later tick (the
average follows a genuine move within a few minutes), so a price pushed just before the
router buys doesn't pass the impact and slippage checks.

## Swap helpers (parallel swaps)

Three helper canisters (`src/helper/main.mo`) run the ICPSwap leg, one swap each at a time,
so up to three swaps proceed at once:

| | |
|-|-|
| helper 0 | `boo25-byaaa-aaaab-qhmaa-cai` |
| helper 1 | `bjp4j-maaaa-aaaab-qhmaq-cai` |
| helper 2 | `bamxv-2iaaa-aaaab-qhmba-cai` |

Per order: the router approves a free helper on the order's deposit account (5-minute
allowance), the helper pulls the ICP, approves the pool and swaps. **ICPSwap (3.7.0) pays the
NAK, or refunds the ICP, from a queue after `depositFromAndSwap` returns**, and deletes the
transaction only once its ledger transfer succeeded; so the helper waits until
`getTransactionsByOwner(helper)` is empty and its unused balance is zero, then sends
everything it holds back to the order's deposit account. The router settles from what the
helper reports (dust sent to the deposit account by anyone changes nothing) and pays NAK, or
refunds ICP, from that account. The 1% fee stays there until it's swept to the fee wallet.
Nothing passes through the router's main account, so swaps can't mix.

Safety:
- A helper refuses work unless its last job ended clean and ICPSwap has nothing pending for
  it. Funds a stranger sends to a helper are set aside to the router's stray account
  (`recover-stray`) before the next job, never mixed into an order.
- If ICPSwap hasn't finished paying out within the wait (or a payout failed on ICPSwap's side),
  the helper keeps everything together, is quarantined and linked to that order, and the order
  waits in "needs review". The worker retries on every tick: as soon as ICPSwap is done, the
  helper hands the funds to the order, goes back into rotation, and the order is paid out or
  refunded automatically. A failed ICPSwap payout needs ICPSwap's admin to retry it (failed
  transactions are kept 30 days); after that recovery is automatic.
- Any result that doesn't match the order (wrong amount, NAK and ICP both back) parks it the
  same way. While helpers are configured the router never swaps through its own account.
- `setHelpers` is controller-only and checks each helper's module hash (`build/helper.wasm`),
  that it was built for this router, and that its controllers equal the router's. Re-run
  `set-helpers` after upgrading the helpers.
- Upgrades: pause the router, upgrade the helpers, upgrade the router, `set-helpers`, unpause.

Helpers need cycles like the router: add them to CycleOps (the balance checker is already
a controller of each).

## NAKSwap fee

1% of the ICP that Houdini delivers to the deposit account (`setFee`, max 5%). The router swaps
`ICP − 1% − 4 ledger fees` for NAK (3 without helpers) and the 1% stays in the order's
deposit account (the router's main account without helpers). It is counted as
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
expired → awaitingDeposit       (ICP arrived late: the late-deposit watch revives it)
anything unexpected → needsReview   (funds are never guessed at; admin uses forceRefund)
```

Safety rails:
- With helpers: each swap is settled in its own deposit account (see "Swap helpers").
  Without helpers: one swap at a time (`busy` lock) through the router's main account, settled
  from balance deltas once ICPSwap has finished paying out.
- Price impact: quotes above `maxImpactBps` − 1.5 points (3.5% today; `MAX_QUOTE_IMPACT_BPS` on
  Railway can lower it) are refused with the largest amount that fits suggested, so drift
  before the swap rarely turns an accepted order into a refund.
- Price check right before the swap: refund if impact > `maxImpactBps`, otherwise `amountOutMinimum` = quote − `slippageBps` (or the user's `minNakOut` if higher).
- Payouts and refunds use a fixed `created_at_time` + memo, so a retry is deduplicated by the ledger instead of paying twice.
- Only `operators` (the relay) can open orders; `poke` is public but throttled to once per 10 s per order.

## Relay API

| | |
|-|-|
| `POST /api/quote` `{fromId, amount, refundAddress?}` | Houdini routes to ICP, each with the NAK the router would deliver, price impact, and `blocked` (+ `suggestAmount`) if over a limit |
| `POST /api/quote-icp` `{amount}` | paying with ICP directly: NAK out, fee, impact, guaranteed minimum, `blocked`/`suggestAmount` |
| `GET /api/stats` | public totals: swaps completed, ICP swapped, NAK delivered (cached 60 s) |
| `POST /api/orders` `{quoteId, recipient, refundAddress, refundTo?}` | Houdini quote: router order → Houdini exchange (addressTo = deposit account) → linked. ICP quote: router order marked `icp-direct`. Returns where to send funds |
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
5. ICPSwap 3.7.0 pays out from a queue after its calls return (handled: helpers wait for it). A
   payout that fails on ICPSwap's side stays as a failed transaction for 30 days and only
   ICPSwap's admin can retry it; the order waits in "needs review" until then.
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
node scripts/router-admin.mjs stats                  # public totals + orders watched for late ICP
node scripts/router-admin.mjs late-check             # look for late ICP in expired orders now
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
node scripts/router-admin.mjs recover <id> <principal>    # ICP + NAK left in a finished/deleted order's deposit account
node scripts/router-admin.mjs helpers                     # which helper is quarantined, and which order it holds
node scripts/router-admin.mjs helper-recover <i> <id>     # helper i -> that order's deposit account (automatic on each tick too)
node scripts/router-admin.mjs force-payout <id> <NAK> deposit   # pay from the order's deposit account
node scripts/router-admin.mjs clear-helper <i>            # back into rotation (only once it's empty)
node scripts/router-admin.mjs recover-stray <principal>   # funds strangers sent to helpers
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
- **Unguessable deposit accounts**: each order's deposit subaccount is a keyed hash of the
  order id under a random secret the router fetched from the IC (`raw_rand`). Outsiders can't
  list them in advance or match one to an order number. Once a deposit account is used, its
  ledger activity (the approval to a helper, the payout from it) is public like any transfer,
  so the ICP that arrived and the principal paid can be linked on-chain.
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

## Admin dashboard and monitoring

**Dashboard:** https://nakswap.lol/admin. Sign in with Internet
Identity (id.ai popup). Internet Identity gives each site its own principal, so the first time,
copy the principal shown at the top and add it as a guardian (controller key):

```bash
node scripts/router-admin.mjs add-guardian <principal>    # remove-guardian / guardians
```

A guardian can see everything (health, cycles of router and helpers, open orders vs cap, orders
needing review, helper state, ICPSwap pending transactions, balances, fees, relay/Houdini
status), freeze and unfreeze swaps, run recovery, and request a security audit. A guardian
can't move funds or change settings (those stay on the controller key). The page flags
unusual behaviour: low cycles, frozen swaps, orders in review, quarantined helpers, helpers
holding funds while idle, ICPSwap pending/failed transactions, stuck fees, open orders near the
cap, unusual order volume, funds sent to helpers by strangers, relay/Houdini down.

Freeze = `setPaused(true)`: no new orders and no new swaps; payouts and refunds already in
progress still complete. Source of the page script: `relay/admin-src/` (`npm install && npm
run build` writes `relay/public/admin/app.js`).

**Audit requests and monitoring:** "Request security audit" records a request on the router
(`auditRequests`, public: ids, times, notes). A scheduled Claude task checks every 2 hours:
it runs `node scripts/monitor.mjs` (key-free health check using only public queries) and, for
each request not yet handled, runs a full security audit. Reports go to the `audits` branch
(`audits/LOG.md` lists handled requests); fixes, if any, go to an `audit-fix/<id>` branch with a
pull request. Nothing is deployed automatically: deploying needs the controller key.

## If something is compromised (runbook)

Freeze first, then rotate. Freezing (dashboard button or `router-admin.mjs pause`) stops new
orders and swaps; payouts and refunds already under way still finish.

- **Relay / Railway compromised** (it could show fake deposit addresses or open spam orders):
  1. `router-admin.mjs pause`.
  2. New relay identity: generate a new 32-byte seed, set `RELAY_IDENTITY_SEED` on Railway, and
     note its principal (`/api/health` → `operator` after redeploy, or derive it locally).
  3. `router-admin.mjs set-operators <new principal>` (removes the old one).
  4. Rotate `HOUDINI_API_KEY` / `HOUDINI_API_SECRET` (Houdini dashboard) and `ORDER_KEY_SECRET`.
  5. Redeploy the relay from a known-good commit; check the page and `/api/health`.
  6. `router-admin.mjs unpause`.
- **Controller key compromised** (it can upgrade the canisters): from the NNS app (admin
  principal, also a controller) remove the compromised controller from the router and every
  helper, then upgrade from a known-good build. Keep controller keys offline.
- **Dashboard guardian compromised**: it can only freeze/unfreeze, run recovery and request
  audits. `router-admin.mjs remove-guardian <principal>`.
- The 2-hourly monitor (`scripts/monitor.mjs`) raises a critical alert if any canister's code
  or controllers change, if the admin, operators, fee or limits change, if the site points
  at a different router or operator, or if the live pages (`/`, `/terms`, `/admin`,
  `/admin/app.js`) differ from the repo's files (re-checked once after 90 s to allow for a
  deploy).

## Live domain: nakswap.lol

Done 2026-10-11 (Cloudflare Registrar + Cloudflare DNS, proxied):
- DNS: `nakswap.lol` and `www` CNAME to Railway (proxied); Railway ownership TXT records;
  CAA `issue letsencrypt.org` (Railway's CA; Cloudflare adds its own CAs); no-mail records
  (SPF `-all`, DMARC `p=reject`, null MX). DNSSEC on. Registrar lock, WHOIS redaction and
  auto-renew on.
- TLS: SSL mode Full, Always HTTPS, TLS 1.2 minimum, TLS 1.3, 0-RTT off.
- Page-rewriting features off (Rocket Loader, Email Obfuscation, Automatic HTTPS Rewrites,
  insecure-JS replacement, Server-side Excludes, Always Online); no Web Analytics injection.
- WAF custom rules: only GET/HEAD/POST; POST only to `/api/`; unknown host names blocked.
  Rate limit: 50 `/api/` requests per 10 s per visitor, then blocked for 10 s.
- Late transform rule sets `x-origin-secret`; Railway `ORIGIN_SECRET` holds the same value
  and `CANONICAL_HOST=nakswap.lol`. The Railway address answers only `/api/health`; page
  links to it redirect to nakswap.lol; `www` redirects to the bare domain.
- If email is ever sent from this domain (e.g. Resend), its records replace the SPF/null MX
  ones; DMARC stays at reject.

## Moving to a custom domain

- Railway: add the domain to the relay service. Either keep the DNS record **DNS-only**, or
  put Cloudflare's proxy in front **with the origin lock** (next section). Never proxy
  without the lock: every visitor would then share Cloudflare's IP (rate limits and Houdini's
  `x-user-ip`), and the Railway address would still bypass Cloudflare.
- Set `CANONICAL_HOST=<the domain>` on Railway: every other host name (the `railway.app` one)
  then redirects there, so there's one site and one admin origin. `/api/health` is exempt.
- Admin dashboard: Internet Identity gives each site its own principal. Sign in at
  `https://<domain>/admin`, then `router-admin.mjs add-guardian <new principal>` and
  `remove-guardian` the old one.
- Update `RELAY_URL` for `scripts/monitor.mjs` (and the scheduled monitor task).
- DNS hygiene: a CAA record for the certificate authority Railway uses (Let's Encrypt), and
  for a domain that sends no mail, SPF `-all` and DMARC `p=reject`.

## Cloudflare in front (optional origin lock)

Puts Cloudflare's DDoS protection, WAF and rate limiting in front of the relay and makes the
Railway address refuse everything that didn't come through Cloudflare.

1. Cloudflare DNS: the domain's record **Proxied** (orange cloud); SSL/TLS mode **Full**
   (Railway's guidance: not Flexible, not Full (Strict)).
2. Generate a random secret of at least 32 characters (e.g. `openssl rand -hex 32`).
3. Cloudflare → Rules → Transform Rules → **Modify Request Header**: for all incoming
   requests, *set static* header `x-origin-secret` = the secret.
4. Railway → relay → Variables: `ORIGIN_SECRET` = the same secret (seal it), and
   `CANONICAL_HOST` = the domain. Redeploy.
5. Check: `https://<domain>/` loads; `https://relay-production-….up.railway.app/` answers
   `403 forbidden` (only `/api/health` stays open, for Railway's health check).
6. Cloudflare → Speed / Scrape Shield: turn **off** Rocket Loader, Email Obfuscation, Auto
   Minify and any HTML rewriting or injected analytics. They change the page, which breaks
   its script hash (CSP) and trips the monitor's page check.
7. Optional Cloudflare rate-limiting rule for `/api/` (the relay's own limits stay on).

With the lock on, the visitor IP comes from `CF-Connecting-IP`, trusted only on requests
carrying the secret. To rotate it: set the new value in Cloudflare and Railway together.
Without `ORIGIN_SECRET` (the default) Cloudflare headers are ignored.

Alternative with no public Railway address at all: a Cloudflare Tunnel (`cloudflared`) as a
second Railway service on the private network, and the relay's public domain removed.

## Abuse and cycle-drain protection

Router (`src/router/main.mo`, `lib/Guard.mo`):
- `inspect` ingress filter: every update call must come from the relay (operator), the admin
  or a controller, with an argument under 2 KB. Everything else from outside the IC,
  including query methods called as updates, is rejected before consensus. (Other canisters
  can still call public methods; every update checks its caller first, and the public
  queries are cheap.)
- `poke`, `getOrder`, `activeOrderIds` are operator/admin only (order ids count up, so a
  public `getOrder` would expose every user's principal). `health`, `getConfig`, `feeStatus`
  stay public queries, which are free for the canister.
- At most 150 open orders. The worker pays out and refunds first, then checks each waiting
  deposit at most once a minute, least recently checked first, 10 per tick.
- Orders the relay never paired with a Houdini exchange or marked as paid in ICP are deleted
  after 15 minutes; the relay cancels (expires) orders whose Houdini exchange expired
  or failed without a deposit, and unpaid direct-ICP orders after 45 minutes, and caps open
  unpaid orders at 5 per visitor.
- Late-deposit watch: bounded (3,000 orders, 10 ledger queries per tick, 3 days each); the
  manual `checkLateDeposits` is guardian-or-admin only and once a minute for guardians.
- `publicStats` reads running totals (no scan of all orders).
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
- Client IP from Railway's `X-Real-IP` (the left end of `X-Forwarded-For` is client-controlled),
  or from `CF-Connecting-IP` when the origin lock is on and the request carried the secret.
- Only GET and POST (HEAD for pages and health); everything else, including OPTIONS, is 405.
  URLs over 2 KB are 414; a declared body over 8 KB is 413 before it is read.
- At most 64 requests that call out to Houdini or the IC at once, 6 per visitor; past that a
  quick 503 / 429 instead of a pile-up. At most 2,000 open connections (`MAX_CONNECTIONS`).
- Orders: 5 per IP per 10 min, 150 per hour overall (`ORDER_LIMIT_PER_HOUR` on Railway to change it). Quotes (Houdini and ICP) 30/min per IP and
  1,200/hour overall, cached 20 s; a used quote is never served again from the cache. Limiter,
  cache and quote-registry memory is bounded (the registry drops its oldest entries, never all).
- Order links are `id-key`, where the key is an HMAC of the id under the relay seed; without
  the key `/api/orders/:id` answers 404. One router poke per order per 15 s.
- Input validation on every field (strings only, plain decimal amounts), JSON only, 8 KB body
  cap, header/request timeouts, 15 s timeouts on outbound calls, no CORS, CSP that allows only
  the page's own script (by hash) and Houdini's token icons, frame/sniffing/referrer headers.
- Orders only against quotes the relay issued in the last 3 minutes, one order per quote, never
  on a route marked unavailable. The relay sets the order's guaranteed minimum NAK (quote −6%; −3% when paying with ICP);
  below that the router refunds ICP instead of filling.
- Houdini's exchange must be ICP paid to this order's deposit account, and the router must
  confirm the pairing, before the user is shown a deposit address.
- A malformed request can't crash the process; internal error text never reaches visitors;
  mock Houdini refuses to start against mainnet. Optional `ORDER_KEY_SECRET` separates order
  links from the operator key.
