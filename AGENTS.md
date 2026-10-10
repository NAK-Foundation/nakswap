# Project Guidance

## User Preferences

- Dark, institutional naktoken.lol look
- Sandbox only — no real funds
- No sign-in, no wallet connection, no roles
- Keep the 'SANDBOX — no real funds' banner

## Verified Commands

- **typecheck**: `pnpm typecheck`
- **fix**: `pnpm fix`
- **build**: `pnpm build`

## Learnings

- react-router-dom is NOT installed; TanStack Router is the router. Build routes with createRootRoute/createRoute/createRouter.
- Motoko module-level let cannot hold non-static expressions; use static Text constants plus actor "principal-text". Timer.recurringTimer<system> must be declared in main.mo, not a mixin.
- tailwind darkMode:['class'] requires an explicit 'dark' class on <html>; index.html is the correct place to set it.
- sonner toast() calls are no-ops unless a <Toaster /> is mounted in the React tree.
- Sandbox and live swap paths are separate functions; size-limit and toggle-reset logic must be verified in both runSwapSandbox and runSwapLive.
- AccessControlState exposes var adminAssigned and userRoles as public fields; AccessControl.isAdmin/getUserRole trap for unregistered principals.
- caffeineai-oql 0.7.0: Map.toEntityManual<K,V>(name, typeName, primaryKey) takes two type args; .sample(...) is required per entity.
- Motoko has no triple-quoted strings; build multi-line text from an array of single-line strings joined with Text.join(iter, sep).
- Local preflight cannot complete Internet Identity sign-in (browser boundary blocks the II canister call), so authenticated flows are verified only by source QA and the component test suite, not by the local browser test.
- The platform useActor hook from @caffeineai/core-infrastructure asserts InternetIdentityProvider; a sandbox-only app with no Internet Identity must build its actor with createActorWithConfig(createActor) in a React Query hook instead.
- The backend keys its token map by tokenKey(symbol, chain) = symbol # ':' # chain; the frontend must send that composite key to getQuote/createOrder/setTokenPrice or the call traps 'Unknown token'.
- Nat32.toNat8() traps when the value exceeds 255; to extract a byte from a shifted Nat32, mask with & 0xFF and convert via Nat8.fromNat(Nat32.toNat(...)).
- A dedicated short Timer.recurringTimer<system> in main.mo can drive a plain (non-async) lib function wrapped in func() : async () { ... }, letting one timer walk the Houdini leg a few seconds per step while a 20s timer handles expiry and router processing.
- Duplicate symbols across chains (USDT, USDC) require React list keys and draft records keyed by 'symbol:chain', not bare symbol.
- The tester-owned files under src/frontend/src/__tests__/ and test/pocketic/ are the tester's; production workers must not edit them, and their type drift is not a production defect.
- pnpm fix (biome check --write src) reformats tester-owned files under src/__tests__/; revert them after running the pipeline to honor the no-edit-tests contract.
