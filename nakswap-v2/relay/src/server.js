import http from 'node:http';
import { createApp } from './app.js';
import { createHoudini } from './houdini.js';
import { createIc } from './ic.js';
import { createMockHoudini } from './mockHoudini.js';
import { createPrices } from './prices.js';

const env = process.env;
const host = env.IC_HOST || 'https://icp-api.io';
const local = /127\.0\.0\.1|localhost/.test(host) || env.IC_LOCAL === '1';
const mode = env.HOUDINI_MODE || (local ? 'mock' : 'live');
if (mode === 'mock' && !local) {
  // Mock Houdini shows fake deposit addresses and pays ICP from the relay identity: never
  // against mainnet.
  console.error('HOUDINI_MODE=mock is only allowed against a local replica. Refusing to start.');
  process.exit(1);
}

// Last-resort guards: log and keep serving rather than exit on a stray rejection.
process.on('unhandledRejection', (e) => console.error(new Date().toISOString(), 'unhandledRejection', String(e?.message || e).slice(0, 200)));
process.on('uncaughtException', (e) => console.error(new Date().toISOString(), 'uncaughtException', String(e?.message || e).slice(0, 200)));

if (!env.RELAY_IDENTITY_SEED) {
  console.warn('RELAY_IDENTITY_SEED is not set: using a throwaway identity. Its principal will not be a router operator.');
}

const ic = await createIc({
  host,
  identitySeedHex: env.RELAY_IDENTITY_SEED,
  routerId: env.ROUTER_CANISTER_ID || null,
  local,
});

if (mode === 'live' && local) {
  console.warn('HOUDINI_MODE=live against a local replica: Houdini cannot pay a local ledger. Use mock.');
}

const houdini =
  mode === 'live'
    ? createHoudini({ apiKey: env.HOUDINI_API_KEY, apiSecret: env.HOUDINI_API_SECRET })
    : createMockHoudini({ payIcp: ic.payIcp, settleAfterMs: Number(env.MOCK_SETTLE_MS || 5_000) });

const prices = createPrices();
// Order-link keys are derived from the relay identity seed, so links survive restarts.
// ORDER_KEY_SECRET, if set, keeps order links separate from the operator key (changing it
// invalidates existing order links, so set it before launch and leave it).
const secret = env.ORDER_KEY_SECRET || (env.RELAY_IDENTITY_SEED ? `nakswap-order-key:${env.RELAY_IDENTITY_SEED}` : undefined);
const orderLimitPerHour = Number(env.ORDER_LIMIT_PER_HOUR) > 0 ? Number(env.ORDER_LIMIT_PER_HOUR) : undefined;
// Optional stricter quote-time price-impact limit in basis points (default: the router's
// refund line minus 1.5 points).
const maxQuoteImpactBps = Number(env.MAX_QUOTE_IMPACT_BPS) > 0 ? Number(env.MAX_QUOTE_IMPACT_BPS) : null;
// Optional: the site's own domain (e.g. swap.example.com). Other host names redirect there.
const canonicalHost = /^[a-z0-9.-]{3,253}$/.test(String(env.CANONICAL_HOST || '').toLowerCase()) ? String(env.CANONICAL_HOST).toLowerCase() : null;
// Optional origin lock (Cloudflare in front): requests without this value in x-origin-secret
// are refused, except /api/health. At least 32 characters; unset = off.
const originSecret = String(env.ORIGIN_SECRET || '');
if (originSecret && originSecret.length < 32) {
  console.error('ORIGIN_SECRET must be at least 32 characters. Refusing to start.');
  process.exit(1);
}
const handle = createApp({ houdini, ic, prices, secret, orderLimitPerHour, maxQuoteImpactBps, canonicalHost, originSecret: originSecret || null, log: (...a) => console.log(new Date().toISOString(), ...a) });
const port = Number(env.PORT || 8787);
const server = http.createServer((req, res) =>
  handle(req, res).catch((e) => {
    console.error(new Date().toISOString(), 'handler error', String(e?.message || e).slice(0, 200));
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"internal error"}');
  }),
);
// Slow-client protection: drop connections that dribble headers or bodies.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;
// Hard ceiling on open connections (a flood gets refused at the socket, not queued).
server.maxConnections = Number(env.MAX_CONNECTIONS) > 0 ? Number(env.MAX_CONNECTIONS) : 2_000;
server.listen(port, () => {
  console.log(`nakswap relay on :${port}`);
  console.log(`  ic host:   ${host}`);
  console.log(`  houdini:   ${houdini.mode}${houdini.ready === false ? ' (API key missing)' : ''}`);
  console.log(`  router:    ${ic.routerId ?? 'not deployed yet'}${ic.routerError ? ` (error: ${ic.routerError})` : ''}`);
  console.log(`  operator:  ${ic.principal}  <- must be in the router's operators list`);
  console.log(`  origin lock: ${originSecret ? 'on (Cloudflare only)' : 'off'}`);
});
