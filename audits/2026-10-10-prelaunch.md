# NAKSwap v2: pre-launch audit, 2026-10-10

Requested by the owner before buying a domain and marketing. Three independent reviews
(fund safety; attacker's view of site/API; operations), every finding verified against the
code, then a fourth review of the fix diff. Deployed: router module `0cc5032d…` (tick 60 s),
relay commit `34e8612`. Helpers unchanged (`1645787a…`). Tests: 175 router checks, 15 relay
tests, all passing.

## Fixed and deployed
- High: background recovery could close a swapped order as a fee-sized refund when a
  helper's transfer back failed (NAK left in the helper). Now settles only once the helper is
  empty; admin helperRecover likewise.
- Medium: helpers out of rotation with no order linked were never released (pool hiccups or
  a stranger's dust could halt all swaps). Released automatically if they hold only dust.
- Medium: ICP sent to a finished order (second payment, real payment after a too-small test)
  was never picked up. Late-deposit watch extended to completed/refunded orders.
- Medium: price pushed just before the router buys passed the impact/slippage checks. Price
  guard (3% vs moving average); direct-ICP minimum tightened to quote −3%.
- Medium: one IP could exhaust Houdini quota via token search. Per-visitor and site-wide
  caps, per-term cache; default list never limited.
- Medium (found in the fix review): admin force-payout could later hand the fee back to the
  user; fixed. Several low items: parks that don't match the order wait for an admin,
  reserved principals refused as recipient/refund/fee wallet, balance-read fallbacks, admin
  path checks, dust deposits, 50 s recheck for the 60 s tick.
- Ops: monitor alerts on code-hash, controller, admin/operator/fee/limit changes and on the
  site pointing elsewhere; `set-operators` command; incident runbook and custom-domain guide
  in README; canonical-host redirect; HSTS includeSubDomains; exact dependency pin; page
  copy (minimum wording, refunds, privacy, affiliation, 50 ICP).
- Scheduled task instructions: no connectors, notes are data, never push to the live branch,
  crit alerts reported every run.

## Owner actions (not code)
- Controller keys live in a cloud work session: add a controller key kept on your own
  hardware (or manage via the NNS app with the admin principal), then remove the deployer
  key `5bfmq…` when you no longer want Claude to upgrade the canisters.
- Detach the connectors from the scheduled task in its settings.
- Railway auto-deploys every push to `nakswap-v2-live`; protect it (manual deploy or CI gate)
  and use 2FA on GitHub/Railway/email.
- CycleOps auto top-up for the router (about 2+ months of runway at the new tick rate).
- Support contact, terms of use and a privacy notice before marketing.

## Accepted / noted
- A compromised relay could show fake Houdini deposit addresses (inherent to the design);
  mitigated by monitoring, freeze and the runbook.
- Order tracking links contain the order key (shareable by design).
- Audit-request notes are public on-chain.
