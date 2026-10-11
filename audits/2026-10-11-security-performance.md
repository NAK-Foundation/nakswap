# NAKSwap v2: security and performance audit, 2026-10-11

Requested by the owner after moving the site to nakswap.lol behind Cloudflare. Three
independent reviews (canister fund safety; attacker's view of the site, API and hosting;
end-to-end performance and cycle cost), every finding checked against the code, then two
independent reviews of the fix diff. Deployed: router module `663274cc…` (tick 60 s),
relay commit `f630423`. Helpers unchanged (`1645787a…`). Tests: 183 router checks, 18
relay tests, all passing. Monitor: ok (code hashes, controllers, config, pages match the
deployed commit, hosting address locked).

No critical or high findings. No path for anyone to take user or fee funds.

## Fixed and deployed

Router
- Medium: a stranger could knock every helper out of rotation for ~0.0004 ICP each by
  sending tokens to a helper mid-swap (the order parked for review, swaps stopped until an
  admin acted). Now every job links its helper to its order until the order's funds are
  out; tokens that arrive mid-swap don't park the order (it is paid at most
  max(quote + 5%, its minimum); extras stay in its deposit account), and an unlinked helper's
  balance (a stranger's) goes to the stray account automatically, with the helper released.
- Low: background recovery could act on a stale helper-to-order link after a long stall.
  It now acts only while the link is still that order's; job exits remove only their own
  link; linked helpers are never claimed for a new job.
- Low: price guard weaker than documented (same-tick sample, guard off after an upgrade).
  The reference is now stable across upgrades and sampled after each tick's swaps, so a swap
  is judged against earlier ticks; a stale reference makes swaps wait for a fresh sample.
- Low: a ledger fee change could hand a held fee to the user via the late-deposit watch.
  The fee record is now kept on BadFee.
- Cost: the late-deposit watch was ~12x the cost of the swap itself. It now backs off
  (10 min for 6 h, hourly to 24 h, then 6-hourly): ~65 checks per order instead of ~440.
  Idle price sampling every 4th tick instead of every tick.
- Latency: a finished swap pays out (or refunds) in the same tick instead of the next one.

Relay, page and monitor
- Medium: one IP could exhaust the site-wide quote budget with repeated (cached) quotes,
  blocking quotes for everyone. The cache is checked first; only real Houdini calls count;
  per-visitor hourly cap; pay-with-ICP quotes have their own budget.
- Medium: free pay-with-ICP orders could fill the router's open-order slots (worse after a
  relay restart, which forgot them). They are limited to 40% of the hourly order budget and
  reloaded from the router after a restart, so they are still cancelled after 45 minutes.
- Medium: monitor blind spots. It now alerts if the site doesn't report its commit, runs a
  commit that isn't on the live branch, or the hosting address answers directly.
- Low: IPv6 visitors were limited per /48 and Houdini received a prefix instead of an IP.
  Now per /64 (written in full) with looser per-/48 outer limits; Houdini gets the address.
- Low: an order link from someone else showed a NAKSwap-branded payment request. Orders not
  created on this device now show a warning and hide where to pay until confirmed.
- Low: the order page could draw one order's details into another's view (poll race) and
  polled forever. Race fixed; polling backs off by stage, pauses in hidden tabs, stops when
  done; router pokes are no longer awaited by the page's request.
- Cloudflare: browser cache TTL now respects the site's headers (the dashboard bundle was
  cached 4 h); fonts cached a year, images a day. Web Analytics injection had switched itself
  on and broke the page's CSP; turned off, and the monitor now fetches pages like a browser.

## Accepted / noted
- Houdini exchange checks (`receiverAddress`, `outSymbol`) only run if Houdini returns those
  fields; the live field names couldn't be verified. Fail-closed once confirmed.
- Tokens sent to a helper during a swap ICPSwap refunds (over 1,000 NAK), or more ICP than
  the order put in, still park the order for an admin (costly for the attacker).
- ICP left over from a partial fill is swapped again or refunded by the late-deposit watch;
  the order page then shows the second outcome.
- A second payment to a finished order keeps the order's original absolute minimum.
- Orders can still be opened by many addresses at once up to the hourly budget; a
  Cloudflare Turnstile check on order creation would stop scripted spam (owner decision:
  adds a Cloudflare script to the page).
- The dashboard shares the swap site's origin; a compromised site could misuse a guardian
  sign-in (freeze/unfreeze only). A separate admin subdomain is an option.
- Not done (bigger changes): relay-driven deposit detection to cut per-order deposit
  checks further; parallel ledger calls inside the helper (needs a helper upgrade).
