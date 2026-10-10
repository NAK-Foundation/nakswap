// Calls into the router canister, the ICPSwap pool (quotes) and, in mock mode, the local
// ICP ledger (to play Houdini's payout).
//
// The router is optional at startup: before it is deployed the relay still serves live
// two-leg quotes (Houdini + the real ICPSwap pool) using MAINNET_DEFAULTS, and order
// creation reports that the router is not deployed yet.
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
import { Principal } from '@icp-sdk/core/principal';
import { icpLedgerIdl, poolIdl, routerIdl } from './idl.js';

const PROBE_E8S = 1_000_000n; // 0.01 ICP, same probe the router uses
const BPS = 10_000n;

// Mirrors the router config used for the mainnet deploy (scripts/deploy-mainnet.mjs).
export const MAINNET_DEFAULTS = {
  icpLedger: Principal.fromText('ryjl3-tyaaa-aaaaa-aaaba-cai'),
  nakLedger: Principal.fromText('eig2s-waaaa-aaaam-qbg5a-cai'),
  pool: Principal.fromText('d6hdt-qiaaa-aaaag-qm76q-cai'),
  icpIsToken0: false,
  icpFee: 10_000n,
  nakFee: 1_000_000n,
  slippageBps: 100n,
  maxImpactBps: 500n,
  minOrderIcp: 10_000_000n, // 0.1 ICP
  maxOrderIcp: 1_000_000_000n, // 10 ICP while testing (~0.7% impact on today's pool)
  orderTtlSeconds: 7_200n,
  paused: false,
};

export class RouterNotReady extends Error {
  constructor() {
    super('The NAKSwap router canister is not deployed yet, so orders cannot be created. Quotes still work.');
    this.status = 503;
  }
}

export async function createIc({ host, identitySeedHex, routerId, local }) {
  const identity = identitySeedHex
    ? Ed25519KeyIdentity.generate(Uint8Array.from(Buffer.from(identitySeedHex, 'hex')))
    : Ed25519KeyIdentity.generate();
  const agent = await HttpAgent.create({ host, identity, shouldFetchRootKey: local });

  let router = null;
  let cfg = { ...MAINNET_DEFAULTS };
  let routerError = null;
  if (routerId) {
    router = Actor.createActor(routerIdl, { agent, canisterId: routerId });
    try {
      cfg = await router.getConfig();
    } catch (e) {
      routerError = e.message;
      router = null;
    }
  }
  const pool = Actor.createActor(poolIdl, { agent, canisterId: cfg.pool });
  const icpLedger = Actor.createActor(icpLedgerIdl, { agent, canisterId: cfg.icpLedger });
  const needRouter = () => {
    if (!router) throw new RouterNotReady();
    return router;
  };

  // Limits can change on the router (setConfig) without a relay restart: re-read them,
  // plus the router's health (cycles / paused), every minute.
  let routerHealth = null;
  async function refresh() {
    if (!router) return;
    try {
      cfg = await router.getConfig();
      routerHealth = await router.health().catch(() => null);
      routerError = null;
    } catch (e) {
      routerError = e.message;
    }
  }
  if (router) {
    await refresh();
    setInterval(refresh, 60_000).unref();
  }

  return {
    principal: identity.getPrincipal().toText(),
    get config() {
      return cfg;
    },
    get routerHealth() {
      return routerHealth;
    },
    get routerError() {
      return routerError;
    },
    routerId: router ? String(routerId) : null,
    refresh,

    parsePrincipal(text) {
      const p = Principal.fromText(String(text || '').trim());
      if (p.isAnonymous()) throw new Error('anonymous principal');
      return p;
    },

    // What the router will do with `icpE8s` once it lands: fees, pool output, price impact.
    // NAKSwap fee in bps of the ICP that reaches the router (100 = 1%). Until health() has
    // been read, assume the default 1% so minNakOut is never set above what the router gives.
    get feeBps() {
      const v = routerHealth?.feeBps;
      return Array.isArray(v) && v.length ? BigInt(v[0]) : typeof v === 'bigint' ? v : 100n;
    },

    // With swap helpers the router spends one more ICP fee (approving the helper) and one
    // more NAK fee (the helper returning NAK to the order's account).
    get usesHelpers() {
      const v = routerHealth?.helpers;
      const n = Array.isArray(v) && v.length ? BigInt(v[0]) : typeof v === 'bigint' ? v : 0n;
      return n > 0n;
    },

    async previewSwap(icpE8s) {
      const fee = cfg.icpFee;
      const icpFees = this.usesHelpers ? 4n : 3n;
      const nakFees = this.usesHelpers ? 3n : 2n;
      const nakswapFee = (icpE8s * this.feeBps) / BPS;
      const amountIn = icpE8s > icpFees * fee + nakswapFee ? icpE8s - icpFees * fee - nakswapFee : 0n;
      if (amountIn === 0n) return { amountIn, nakswapFee, nakOut: 0n, impactBps: 0n };
      const zeroForOne = cfg.icpIsToken0;
      const [q, m] = await Promise.all([
        pool.quote({ amountIn: amountIn.toString(), zeroForOne, amountOutMinimum: '0' }),
        pool.quote({ amountIn: PROBE_E8S.toString(), zeroForOne, amountOutMinimum: '0' }),
      ]);
      if (!('ok' in q) || !('ok' in m)) throw new Error('pool quote failed');
      const effective = (q.ok * PROBE_E8S * BPS) / (amountIn * m.ok);
      const impactBps = effective >= BPS ? 0n : BPS - effective;
      // Pool withdraw fee + router payout fee (+ helper return fee) come out of the NAK side.
      const nakCost = nakFees * cfg.nakFee;
      const nakOut = q.ok > nakCost ? q.ok - nakCost : 0n;
      const minNakOut = (q.ok * (BPS - cfg.slippageBps)) / BPS;
      return { amountIn, nakswapFee, nakOut, impactBps, minNakOut: minNakOut > nakCost ? minNakOut - nakCost : 0n };
    },

    async createOrder({ recipient, refundTo, minNakOut }) {
      const r = await needRouter().createOrder({
        recipient,
        refundTo: refundTo ? [refundTo] : [],
        minNakOut: minNakOut ? [minNakOut] : [],
      });
      if ('err' in r) {
        const why = Object.keys(r.err)[0];
        const msg =
          why === 'paused'
            ? 'Swaps are paused right now (maintenance or a cycles top-up). Nothing was sent; try again shortly.'
            : why === 'anonymousRecipient'
              ? 'That principal is the anonymous principal. Paste the principal of a wallet you control.'
              : why === 'invalidRecipient'
                ? "That principal is the NAKSwap router itself. Paste your own wallet's principal."
                : why === 'tooManyOpenOrders'
                  ? 'NAKSwap has too many swaps in progress right now. Nothing was sent; try again in a few minutes.'
                  : `The router refused the order (${why}).`;
        throw Object.assign(new Error(msg), { status: why === 'paused' || why === 'tooManyOpenOrders' ? 503 : 400, expose: true });
      }
      return r.ok;
    },

    attachHoudini: (id, houdiniId) => needRouter().attachHoudini(id, houdiniId),
    cancelUnfunded: (id) => needRouter().cancelUnfunded(id),
    getOrder: async (id) => (await needRouter().getOrder(id))[0] ?? null,
    poke: (id) => needRouter().poke(id),

    // Mock-mode only: send ICP from the relay identity to an account-id hex, like an
    // exchange payout. The relay identity must hold ICP on the local ledger.
    async payIcp(accountIdHex, e8s) {
      const r = await icpLedger.transfer({
        memo: 0n,
        amount: { e8s },
        fee: { e8s: cfg.icpFee },
        from_subaccount: [],
        to: Uint8Array.from(Buffer.from(accountIdHex, 'hex')),
        created_at_time: [],
      });
      if ('Err' in r) throw new Error(`ICP payout failed: ${Object.keys(r.Err)[0]}`);
      return r.Ok;
    },
  };
}
