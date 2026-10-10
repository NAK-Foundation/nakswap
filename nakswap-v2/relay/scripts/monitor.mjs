// Key-free health check of the live NAKSwap system, for the scheduled monitor/audit task
// (and for humans). Uses only public queries. Prints JSON:
//   { at, level: 'ok'|'warn'|'crit', alerts: [{ level, text }], status, helpers, audits }
//
//   node scripts/monitor.mjs            (from relay/)
import { Actor, HttpAgent, AnonymousIdentity } from '@icp-sdk/core/agent';
import { Principal } from '@icp-sdk/core/principal';

const HOST = 'https://icp-api.io';
const ROUTER = Principal.fromText(process.env.ROUTER_CANISTER_ID || 'bkyfl-uyaaa-aaaab-qhl5q-cai');
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const NAK_LEDGER = 'eig2s-waaaa-aaaam-qbg5a-cai';
const POOL = 'd6hdt-qiaaa-aaaag-qm76q-cai';
const RELAY = process.env.RELAY_URL || 'https://relay-production-e42e.up.railway.app';
const HELPERS = (process.env.HELPER_IDS || 'boo25-byaaa-aaaab-qhmaa-cai,bjp4j-maaaa-aaaab-qhmaq-cai,bamxv-2iaaa-aaaab-qhmba-cai').split(',');
// Must match Account.straySubaccount in src/common/Account.mo.
const STRAY = Uint8Array.from([0x4e, 0x41, 0x4b, 0x53, 0x57, 0x41, 0x50, 0x2d, 0x53, 0x54, 0x52, 0x41, 0x59, ...new Array(18).fill(0), 1]);
const T = 1e12;

const agent = await HttpAgent.create({ host: HOST, identity: new AnonymousIdentity() });
const router = Actor.createActor(
  ({ IDL }) =>
    IDL.Service({
      publicStatus: IDL.Func(
        [],
        [
          IDL.Record({
            paused: IDL.Bool,
            acceptingOrders: IDL.Bool,
            cycles: IDL.Nat,
            openOrders: IDL.Nat,
            maxOpenOrders: IDL.Nat,
            needsReview: IDL.Nat,
            helpers: IDL.Nat,
            quarantinedHelpers: IDL.Nat,
            ordersWithHelperFunds: IDL.Nat,
            stuckFees: IDL.Nat,
            ordersLastHour: IDL.Nat,
          }),
        ],
        ['query'],
      ),
      auditRequests: IDL.Func([], [IDL.Vec(IDL.Record({ id: IDL.Nat, at: IDL.Int, note: IDL.Text }))], ['query']),
    }),
  { agent, canisterId: ROUTER },
);
const ledger = (id) =>
  Actor.createActor(
    ({ IDL }) =>
      IDL.Service({
        icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ['query']),
      }),
    { agent, canisterId: id },
  );
const pool = Actor.createActor(
  ({ IDL }) => {
    const Err = IDL.Variant({ CommonError: IDL.Null, InsufficientFunds: IDL.Null, InternalError: IDL.Text, UnsupportedToken: IDL.Text });
    return IDL.Service({
      getTransactionsByOwner: IDL.Func([IDL.Principal], [IDL.Variant({ ok: IDL.Vec(IDL.Tuple(IDL.Nat, IDL.Reserved)), err: Err })], ['query']),
    });
  },
  { agent, canisterId: POOL },
);
const helperActor = (id) =>
  Actor.createActor(
    ({ IDL }) => IDL.Service({ health: IDL.Func([], [IDL.Record({ cycles: IDL.Nat, busy: IDL.Bool, lastClean: IDL.Bool })], ['query']) }),
    { agent, canisterId: id },
  );

const icp = ledger(ICP_LEDGER);
const nak = ledger(NAK_LEDGER);
const pending = async (p) => {
  const r = await pool.getTransactionsByOwner(p).catch(() => null);
  return r && 'ok' in r ? r.ok.length : -1;
};

const alerts = [];
const add = (level, text) => alerts.push({ level, text });

const status = await router.publicStatus();
const audits = await router.auditRequests();
const cyc = Number(status.cycles) / T;
if (status.paused) add('warn', 'Swaps are frozen (paused).');
if (cyc < 0.5) add('crit', `Router cycles critically low: ${cyc.toFixed(2)}T`);
else if (cyc < 1.5) add('warn', `Router cycles getting low: ${cyc.toFixed(2)}T`);
if (status.needsReview > 0n) add('warn', `${status.needsReview} order(s) need review`);
if (status.quarantinedHelpers > 0n) add('warn', `${status.quarantinedHelpers} helper(s) out of rotation`);
if (status.stuckFees > 0n) add('warn', `${Number(status.stuckFees) / 1e8} ICP of fees with unknown outcome`);
const open = Number(status.openOrders);
const cap = Number(status.maxOpenOrders);
if (open >= cap * 0.9) add('crit', `${open}/${cap} open orders: about to refuse new orders (spam?)`);
else if (open >= cap * 0.6) add('warn', `${open}/${cap} open orders`);
if (Number(status.ordersLastHour) > 60) add('warn', `${status.ordersLastHour} orders in the last hour (unusual volume)`);
const routerPending = await pending(ROUTER);
if (routerPending > 0) add('warn', `ICPSwap has ${routerPending} pending/failed transaction(s) for the router`);

const helpers = [];
for (const [i, id] of HELPERS.entries()) {
  const p = Principal.fromText(id);
  const h = await helperActor(id).health().catch(() => null);
  const [hi, hn, hp] = await Promise.all([icp.icrc1_balance_of({ owner: p, subaccount: [] }), nak.icrc1_balance_of({ owner: p, subaccount: [] }), pending(p)]);
  helpers.push({ id, cycles: h ? Number(h.cycles) / T : null, busy: h?.busy ?? null, lastClean: h?.lastClean ?? null, icp: Number(hi) / 1e8, nak: Number(hn) / 1e8, poolPending: hp });
  if (!h) add('crit', `Helper ${i} not answering`);
  else {
    if (Number(h.cycles) / T < 0.1) add('crit', `Helper ${i} cycles critically low`);
    else if (Number(h.cycles) / T < 0.3) add('warn', `Helper ${i} cycles getting low`);
    if (!h.busy && (hi > 10_000n || hn > 1_000_000n)) add('warn', `Helper ${i} holds funds while idle`);
    if (!h.busy && hp > 0) add('warn', `ICPSwap has ${hp} pending/failed transaction(s) for helper ${i}`);
  }
}
const [si, sn] = await Promise.all([icp.icrc1_balance_of({ owner: ROUTER, subaccount: [STRAY] }), nak.icrc1_balance_of({ owner: ROUTER, subaccount: [STRAY] })]);
if (si > 10_000n || sn > 1_000_000n) add('info', `Stray funds set aside from helpers: ${Number(si) / 1e8} ICP, ${Number(sn) / 1e8} NAK`);

const relay = await fetch(`${RELAY}/api/health`, { signal: AbortSignal.timeout(15_000) })
  .then((r) => r.json())
  .catch(() => null);
if (!relay) add('crit', 'Relay (swap site) not answering');
else {
  if (!relay.houdiniReady) add('crit', 'Houdini not connected on the relay');
  if (relay.routerError) add('crit', 'Relay cannot reach the router');
}

const level = alerts.some((a) => a.level === 'crit') ? 'crit' : alerts.some((a) => a.level === 'warn') ? 'warn' : 'ok';
const out = {
  at: new Date().toISOString(),
  level,
  alerts,
  status: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
  helpers,
  audits: audits.map((a) => ({ id: Number(a.id), at: new Date(Number(a.at / 1_000_000n)).toISOString(), note: a.note })),
};
console.log(JSON.stringify(out, null, 2));
process.exit(0);
