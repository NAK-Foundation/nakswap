import http from 'node:http';
import { createApp } from './app.js';
import { createHoudini } from './houdini.js';
import { createIc } from './ic.js';
import { createMockHoudini } from './mockHoudini.js';

const env = process.env;
const host = env.IC_HOST || 'https://icp-api.io';
const local = /127\.0\.0\.1|localhost/.test(host) || env.IC_LOCAL === '1';
const mode = env.HOUDINI_MODE || (local ? 'mock' : 'live');

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

const handle = createApp({ houdini, ic, log: (...a) => console.log(new Date().toISOString(), ...a) });
const port = Number(env.PORT || 8787);
http.createServer(handle).listen(port, () => {
  console.log(`nakswap relay on :${port}`);
  console.log(`  ic host:   ${host}`);
  console.log(`  houdini:   ${houdini.mode}${houdini.ready === false ? ' (API key missing)' : ''}`);
  console.log(`  router:    ${ic.routerId ?? 'not deployed yet'}${ic.routerError ? ` (error: ${ic.routerError})` : ''}`);
  console.log(`  operator:  ${ic.principal}  <- must be in the router's operators list`);
});
