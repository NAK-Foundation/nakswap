import { PocketIc } from "@dfinity/pic";
import type { Actor, CanisterFixture } from "@dfinity/pic";
import { Principal } from "@icp-sdk/core/principal";
import { afterAll, beforeAll, expect, it } from "vitest";

import { idlFactory } from "../../src/frontend/src/declarations/backend.did.js";
import type { _SERVICE } from "../../src/frontend/src/declarations/backend.did";

const PIC_URL = process.env.POCKET_IC_URL ?? "";
const BACKEND_WASM = process.env.BACKEND_WASM ?? "";
// Set only on a converted project: the last pre-EM revision, whose schema this
// app's migration chain replays from.
const BASELINE_WASM = process.env.BACKEND_WASM_BASELINE;

let pic: PocketIc | undefined;
let actor: Actor<_SERVICE>;
let canisterId: CanisterFixture<_SERVICE>["canisterId"];

beforeAll(async () => {
  pic = await PocketIc.create(PIC_URL);
  if (BASELINE_WASM === undefined) {
    ({ actor, canisterId } = await pic.setupCanister<_SERVICE>({
      idlFactory,
      wasm: BACKEND_WASM,
    }));
    return;
  }
  const installed = await pic.setupCanister<_SERVICE>({
    idlFactory,
    wasm: BASELINE_WASM,
  });
  await pic.upgradeCanister({
    canisterId: installed.canisterId,
    wasm: BACKEND_WASM,
    arg: new Uint8Array(),
  });
  ({ actor, canisterId } = installed);
});

afterAll(async () => {
  await pic?.tearDown();
});

it("answers an empty-state read instead of trapping", async () => {
  await expect(actor.listOrders([])).resolves.toEqual([]);
});

it("reads the seeded token catalogue", async () => {
  const tokens = await actor.listTokens();
  expect(tokens.length).toBeGreaterThanOrEqual(17);
  expect(tokens.map((t) => t.symbol)).toContain("ICP");
});

/**
 * The frontend's own call shape: it reads `listTokens()` and passes each
 * token's `symbol:chain` key to `getQuote`/`createOrder` (see
 * `src/frontend/src/pages/SwapPage.tsx` and `hooks/useBackend.ts`). This test
 * drives that exact seam against the real canister, so a token the catalogue
 * advertises must be quotable by the key the catalogue gives it.
 */
it("quotes a token by the symbol the catalogue advertises", async () => {
  const tokens = await actor.listTokens();
  const eth = tokens.find((t) => t.symbol === "ETH");
  expect(eth).toBeDefined();

  const quote = await actor.getQuote(
    `${eth!.symbol}:${eth!.chain}`,
    100_000_000n,
    { standard: null },
  );
  expect(quote.houdini.tokenSymbol).toBe("ETH");
  expect(quote.router.icpIn).toBeGreaterThan(0n);
});

it("rejects the anonymous principal as the NAK recipient", async () => {
  const tokens = await actor.listTokens();
  const eth = tokens.find((t) => t.symbol === "ETH");
  expect(eth).toBeDefined();

  await expect(
    actor.createOrder(
      Principal.fromText("2vxsx-fae"),
      `${eth!.symbol}:${eth!.chain}`,
      100_000_000n,
      { standard: null },
      [],
    ),
  ).rejects.toThrow(/anonymous principal/u);
});

it("creates an order for a token by the symbol the catalogue advertises", async () => {
  const tokens = await actor.listTokens();
  const eth = tokens.find((t) => t.symbol === "ETH");
  expect(eth).toBeDefined();

  const recipient = Principal.fromText("aaaaa-aa");
  const id = await actor.createOrder(
    recipient,
    `${eth!.symbol}:${eth!.chain}`,
    100_000_000n,
    { standard: null },
    [],
  );
  const order = await actor.getOrder(id);
  expect(order).not.toBeNull();
  expect(order?.[0]?.tokenSymbol).toBe("ETH");
  expect(order?.[0]?.recipient.toText()).toBe("aaaaa-aa");
});

/**
 * The Test Controls console drives these methods from the frontend
 * (`src/frontend/src/hooks/useBackend.ts`). Each is called here so a stubbed or
 * trapping implementation cannot deploy behind a green frontend suite.
 */
it("reads and writes the router config", async () => {
  const config = await actor.getConfig();
  expect(config.slippageBps).toBeGreaterThan(0n);

  await expect(
    actor.setConfig({
      slippageBps: 100n,
      maxOrderIcp: 50_000_000_000n,
      maxImpactBps: 500n,
      orderTtlSeconds: 1800n,
      paused: false,
      minOrderIcp: 10_000_000n,
    }),
  ).resolves.toBeNull();

  const updated = await actor.getConfig();
  expect(updated.slippageBps).toBe(100n);
  expect(updated.orderTtlSeconds).toBe(1800n);
});

it("reads and writes the sandbox test toggles", async () => {
  const toggles = await actor.getTestToggles();
  expect(toggles).toMatchObject({
    failNextNakPayout: expect.any(Boolean),
    poolWithdrawFailsNextSwap: expect.any(Boolean),
    houdiniLegFailsNextOrder: expect.any(Boolean),
  });

  await expect(
    actor.setTestToggles({
      failNextNakPayout: true,
      poolWithdrawFailsNextSwap: false,
      houdiniLegFailsNextOrder: false,
    }),
  ).resolves.toBeNull();

  expect(await actor.getTestToggles()).toMatchObject({
    failNextNakPayout: true,
  });
});

it("reads and writes token and ICP prices", async () => {
  const tokens = await actor.listTokens();
  const eth = tokens.find((t) => t.symbol === "ETH");
  expect(eth).toBeDefined();

  await expect(
    actor.setTokenPrice(`${eth!.symbol}:${eth!.chain}`, 3_500_000n),
  ).resolves.toBeNull();
  const updated = (await actor.listTokens()).find((t) => t.symbol === "ETH");
  expect(updated?.usdMicro).toBe(3_500_000n);

  await expect(actor.setIcpPrice(4_000_000n)).resolves.toBeNull();
  expect(await actor.getIcpPrice()).toBe(4_000_000n);
});

it("reads the sandbox balances snapshot and a principal's NAK balance", async () => {
  const balances = await actor.getSandboxBalances();
  expect(balances.pool.icp).toBeGreaterThan(0n);
  expect(balances.pool.nak).toBeGreaterThan(0n);

  const recipient = Principal.fromText("aaaaa-aa");
  await expect(actor.getNakBalance(recipient)).resolves.toBeGreaterThanOrEqual(0n);
});

it("simulates a deposit and advances the order through the router", async () => {
  const tokens = await actor.listTokens();
  const eth = tokens.find((t) => t.symbol === "ETH");
  expect(eth).toBeDefined();

  const recipient = Principal.fromText("aaaaa-aa");
  const id = await actor.createOrder(
    recipient,
    `${eth!.symbol}:${eth!.chain}`,
    100_000_000n,
    { standard: null },
    [],
  );

  await expect(actor.simulateDeposit(id)).resolves.toBeNull();
  const confirming = await actor.getOrder(id);
  expect(confirming?.[0]?.houdiniStatus).toEqual({ confirming: null });

  // The router leg only advances once the Houdini leg has credited ICP; the
  // background timer drives that, so the first processOrder is a noop here.
  // The declarations speak Candid variant shapes (`{ noop: null }`), not the
  // frontend wrapper's `__kind__` union.
  const first = await actor.processOrder(id);
  expect(first).toEqual({ noop: null });
});

it("resets the sandbox to its seeded state", async () => {
  await expect(actor.resetSandbox()).resolves.toBeNull();

  const tokens = await actor.listTokens();
  expect(tokens.length).toBeGreaterThanOrEqual(17);
  expect(await actor.listOrders([])).toEqual([]);
});
