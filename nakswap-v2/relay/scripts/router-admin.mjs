// Small admin tool for the live router, signed with the controller key.
//
//   CONTROLLER_PEM=nakswap-router-controller.pem node scripts/router-admin.mjs health
//   ... set max-order-icp 30          (any numeric Config field: min-order-icp, max-impact-bps,
//                                       slippage-bps, order-ttl-seconds; ICP fields take ICP)
//   ... pause | unpause
//   ... freezing-days 90              (canister freezing threshold, in days of idle burn)
//
// Use CONTROLLER_SEED=<64 hex> instead of CONTROLLER_PEM if you have the raw seed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity';
import { Principal } from '@icp-sdk/core/principal';
import { routerIdl } from '../src/idl.js';

const env = process.env;
const ROUTER = Principal.fromText(env.ROUTER_CANISTER_ID || 'bkyfl-uyaaa-aaaab-qhl5q-cai');

function seed() {
  if (env.CONTROLLER_SEED) return Buffer.from(env.CONTROLLER_SEED, 'hex');
  if (env.CONTROLLER_PEM) {
    const jwk = crypto.createPrivateKey(fs.readFileSync(env.CONTROLLER_PEM)).export({ format: 'jwk' });
    return Buffer.from(jwk.d, 'base64url');
  }
  console.error('set CONTROLLER_PEM or CONTROLLER_SEED');
  process.exit(1);
}

const identity = Ed25519KeyIdentity.generate(Uint8Array.from(seed()));
const agent = await HttpAgent.create({ host: env.IC_HOST || 'https://icp-api.io', identity });

const healthIdl = ({ IDL }) =>
  IDL.Service({
    health: IDL.Func(
      [],
      [
        IDL.Record({
          cycles: IDL.Nat,
          lowCyclesThreshold: IDL.Nat,
          acceptingOrders: IDL.Bool,
          paused: IDL.Bool,
          activeOrders: IDL.Nat,
          nextOrderId: IDL.Nat,
        }),
      ],
      ['query'],
    ),
    setConfig: IDL.Func([routerIdl({ IDL })._fields.find(([n]) => n === 'getConfig')[1].retTypes[0]], [IDL.Bool], []),
    setPaused: IDL.Func([IDL.Bool], [IDL.Bool], []),
  });
const router = Actor.createActor((x) => {
  const base = routerIdl(x);
  const extra = healthIdl(x);
  return x.IDL.Service(Object.fromEntries([...base._fields, ...extra._fields]));
}, { agent, canisterId: ROUTER });

const mgmt = Actor.createActor(
  ({ IDL }) =>
    IDL.Service({
      update_settings: IDL.Func(
        [
          IDL.Record({
            canister_id: IDL.Principal,
            settings: IDL.Record({ freezing_threshold: IDL.Opt(IDL.Nat) }),
            sender_canister_version: IDL.Opt(IDL.Nat64),
          }),
        ],
        [],
        [],
      ),
      canister_status: IDL.Func(
        [IDL.Record({ canister_id: IDL.Principal })],
        [
          IDL.Record({
            cycles: IDL.Nat,
            idle_cycles_burned_per_day: IDL.Nat,
            settings: IDL.Record({ freezing_threshold: IDL.Nat, controllers: IDL.Vec(IDL.Principal) }),
          }),
        ],
        [],
      ),
    }),
  { agent, canisterId: Principal.fromText('aaaaa-aa'), effectiveCanisterId: ROUTER },
);

const show = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x?._isPrincipal ? x.toText() : x), 2);
const FIELDS = {
  'max-order-icp': ['maxOrderIcp', 1e8],
  'min-order-icp': ['minOrderIcp', 1e8],
  'max-impact-bps': ['maxImpactBps', 1],
  'slippage-bps': ['slippageBps', 1],
  'order-ttl-seconds': ['orderTtlSeconds', 1],
};

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'health') {
  const h = await router.health();
  const s = await mgmt.canister_status({ canister_id: ROUTER });
  console.log(show(h));
  console.log(`cycles ${(Number(s.cycles) / 1e12).toFixed(3)}T, idle burn ${(Number(s.idle_cycles_burned_per_day) / 1e9).toFixed(2)}B/day, freezing threshold ${(Number(s.settings.freezing_threshold) / 86400).toFixed(0)} days`);
  console.log('config', show(await router.getConfig()));
} else if (cmd === 'set' && FIELDS[a]) {
  const [field, scale] = FIELDS[a];
  const cfg = await router.getConfig();
  const next = { ...cfg, [field]: BigInt(Math.round(Number(b) * scale)) };
  console.log(`setConfig ${field}: ${cfg[field]} -> ${next[field]}:`, await router.setConfig(next));
} else if (cmd === 'pause' || cmd === 'unpause') {
  console.log(cmd, await router.setPaused(cmd === 'pause'));
} else if (cmd === 'freezing-days') {
  await mgmt.update_settings({
    canister_id: ROUTER,
    settings: { freezing_threshold: [BigInt(Math.round(Number(a) * 86400))] },
    sender_canister_version: [],
  });
  console.log('freezing threshold set to', a, 'days');
} else {
  console.log('commands: health | set <field> <value> | pause | unpause | freezing-days <n>');
  console.log('fields:', Object.keys(FIELDS).join(', '));
}
