# Design Brief

## Direction

Terminal Swap Desk — a sign-in-free sandbox swap console where one HoudiniSwap-style card settles two legs like a ledger, not a consumer crypto app.

## Tone

Brutally restrained dark fintech: near-black surfaces, one amber-gold accent, mono numerals as the only decoration. No gradients on chrome, no glow.

## Differentiation

Leg identity by color: Leg 1 (Houdini) reads cool cyan, Leg 2 (NAKSwap router) reads amber-gold, and the combined timeline shows both rails converging on one delivered amount. The deposit-address card is the one recessed, sunken surface — it looks like a terminal address pane, not a marketing card.

## Color Palette

| Token       | OKLCH           | Role                                            |
| ----------- | --------------- | ----------------------------------------------- |
| background  | 0.115 0.004 250 | Near-black app canvas, faint cool cast          |
| foreground  | 0.92 0.004 250  | Primary text, high contrast                     |
| card        | 0.148 0.005 250 | Swap card, quote panel, orders list            |
| primary     | 0.78 0.135 72   | Amber-gold accent — CTA, Leg 2 (NAKSwap), active|
| leg-houdini | 0.72 0.11 215   | Cool cyan — Leg 1 (Houdini) identity            |
| muted       | 0.2 0.006 250   | Inactive toggle, table stripes, secondary chips |
| destructive | 0.6 0.21 27     | Refunds, expired orders, failed legs            |
| success     | 0.68 0.15 150   | Completed legs, delivered NAK                   |
| warning     | 0.78 0.135 72   | Router refund warning, low/over order limits    |

## Typography

- Display: Space Grotesk — card title, leg labels, section headings, route-type toggle
- Body: DM Sans — form labels, token names, descriptions, helper text
- Mono: JetBrains Mono — amounts, account IDs, deposit addresses, block index, status codes (`.num` / `.addr`)
- Scale: card title `text-xl md:text-2xl font-semibold tracking-tight`, label `text-[11px] font-semibold tracking-[0.18em] uppercase text-muted-foreground`, amount `text-2xl md:text-3xl num`, row `text-sm`, meta `text-xs text-muted-foreground`

## Elevation & Depth

Flat institutional surfaces with hairline borders; depth from layered near-black steps (background → card → surface-raised), `shadow-deposit-inset` on the recessed deposit-address card, and `shadow-swap-card` on the one swap card — never glow.

## Structural Zones

| Zone          | Background        | Border   | Notes                                                              |
| ------------- | ----------------- | -------- | ------------------------------------------------------------------ |
| Sandbox rail  | bg-primary/10     | border-b | Full-width "SANDBOX — no real funds", amber dot, mono wordmark      |
| Header        | bg-card           | border-b | Wordmark + nav; accent underline on active nav                     |
| Swap card     | bg-card           | border   | `shadow-swap-card`, centered max-w-xl, the focal element           |
| Deposit card  | surface-sunken    | border   | Recessed address pane inside the order view, `.addr` hashes        |
| Test Controls | bg-muted/30       | border-t | Open panel: price editors, config form, toggles, balances, reset   |
| Footer        | bg-muted/40       | border-t | Env/network meta in mono, muted-foreground                         |

## Spacing & Rhythm

Spacious desktop (`py-12` sections, `gap-6` panels), compact mobile (`py-8`, `gap-4`); micro-spacing `space-y-2` within quote rows, `gap-3` in the combined timeline and leg breakdown, `gap-2` in picker rows.

## Component Patterns

- Buttons: sharp `rounded-md`, primary = amber-gold with dark text; ghost for secondary; destructive for refund/failed states; hover `/90` + `shadow-inset-soft`
- Swap card: `rounded-xl bg-card border border-border shadow-swap-card`, mono header strip with a status dot
- Deposit card: `rounded-lg surface-sunken border border-border shadow-deposit-inset`, `.addr` mono hash, copy button flush right
- Leg rows: `leg-houdini` / `leg-nakswap` left rail, mono amounts, label in muted uppercase
- Token picker: searchable dropdown, each row `gap-2` with circular logo/initials, symbol + name, chain badge pill; active row `bg-accent/10`
- Badges: pill `rounded-full`, uppercase micro-label; chain badge muted, route-type Standard = muted, Private = primary
- Test Controls: `bg-muted/30` border-t panel, two-column config form, switch toggles, mono balance readouts

## Motion

- Entrance: `animate-fade-up` on the swap card and order view, 400ms
- In-flight leg: `animate-leg-pulse` on the active status dot, `animate-sweep` shimmer across the active leg rail
- Countdown: `animate-countdown` thin amber bar under the deposit address (30-minute scaleX)
- Hover: `transition-smooth`, borders brighten to `border-primary/40`, no scale bounce

## Constraints

- Dark mode is the shipped theme; light tokens exist only as a fallback and are not surfaced
- Sandbox only: no sign-in, no wallet, no Live mode, no real ledger or ICPSwap calls — the rail is always amber
- All amounts, account IDs, addresses, and block indices use `.num` / `.addr` (mono, tabular); never proportional body font
- No raw hex/rgb in components — semantic tokens only

## Signature Detail

The two-rail convergence timeline: Leg 1 cyan and Leg 2 amber-gold run as separate labeled rails inside one combined status timeline, meeting at "Z NAK delivered to <PID>" with the simulated block index in mono.
