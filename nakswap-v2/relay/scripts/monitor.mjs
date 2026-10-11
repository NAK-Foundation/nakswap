// Key-free health check of the live NAKSwap system, for the scheduled monitor/audit task
// (and for humans). Uses only public queries. Prints JSON:
//   { at, level: 'ok'|'warn'|'crit', alerts: [{ level, text }], status, helpers, audits }
//
//   node scripts/monitor.mjs            (from relay/)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Actor, AnonymousIdentity, CanisterStatus, HttpAgent } from '@icp-sdk/core/agent';
import { Principal } from '@icp-sdk/core/principal';
import { routerIdl } from '../src/idl.js';

const HOST = 'https://icp-api.io';
const ROUTER = Principal.fromText(process.env.ROUTER_CANISTER_ID || 'bkyfl-uyaaa-aaaab-qhl5q-cai');
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const NAK_LEDGER = 'eig2s-waaaa-aaaam-qbg5a-cai';
const POOL = 'd6hdt-qiaaa-aaaag-qm76q-cai';
const RELAY = process.env.RELAY_URL || 'https://nakswap.lol';
const HELPERS = (process.env.HELPER_IDS || 'boo25-byaaa-aaaab-qhmaa-cai,bjp4j-maaaa-aaaab-qhmaq-cai,bamxv-2iaaa-aaaab-qhmba-cai').split(',');
// Must match Account.straySubaccount in src/common/Account.mo.
const STRAY = Uint8Array.from([0x4e, 0x41, 0x4b, 0x53, 0x57, 0x41, 0x50, 0x2d, 0x53, 0x54, 0x52, 0x41, 0x59, ...new Array(18).fill(0), 1]);
const T = 1e12;

// What the live system should look like. Code hashes default to this checkout's build files
// (so they match whenever the deployed commit is checked out); the rest to today's setup.
const here = path.dirname(new URL(import.meta.url).pathname);
const sha = (f) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(here, '..', '..', 'build', f))).digest('hex');
  } catch {
    return null;
  }
};
const list = (v, d) => (v || d).split(',').map((x) => x.trim()).filter(Boolean).sort();
const ADMIN_PID = 'ym3yz-lpqvj-spesx-r7efc-opibs-gjpts-erxs6-h4fa6-67wby-dnea7-rqe';
const EXPECT = {
  routerHash: process.env.EXPECT_ROUTER_HASH || sha('router.wasm'),
  helperHash: process.env.EXPECT_HELPER_HASH || sha('helper.wasm'),
  controllers: list(process.env.EXPECT_CONTROLLERS, `cpbhu-5iaaa-aaaad-aalta-cai,5bfmq-m63b2-ekefm-x7uss-tyi4m-kw5if-pjg24-ut2nt-pbm2d-k5tbl-dae,${ADMIN_PID}`),
  admin: process.env.EXPECT_ADMIN || ADMIN_PID,
  operators: list(process.env.EXPECT_OPERATORS, 'cih3k-q7hz3-6sleb-2m76m-ebrtd-qw7jo-wwnde-62a3t-by36t-a6hmp-2ae'),
  feeTo: process.env.EXPECT_FEE_TO || ADMIN_PID,
  // Where the stray account (dust) is paid out automatically.
  dustTo: process.env.EXPECT_DUST_TO || 'ttfax-iely3-bkfh4-tb7o3-dso2i-acf6j-yh6w5-jclgp-7mnhg-lxbzi-qae',
  feeBps: Number(process.env.EXPECT_FEE_BPS || 100),
  maxOrderIcp: Number(process.env.EXPECT_MAX_ORDER_ICP || 50),
  // Safety limits a stolen admin key could loosen.
  maxSlippageBps: Number(process.env.EXPECT_MAX_SLIPPAGE_BPS || 100),
  maxImpactBps: Number(process.env.EXPECT_MAX_IMPACT_BPS || 500),
  minOrderIcp: Number(process.env.EXPECT_MIN_ORDER_ICP || 1),
  maxOrderTtlSeconds: Number(process.env.EXPECT_MAX_ORDER_TTL || 7_200),
};

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
if (si > 10_000n || sn > 1_000_000n) add('info', `Stray account (dust, paid out automatically at the threshold): ${Number(si) / 1e8} ICP, ${Number(sn) / 1e8} NAK`);

// ---- integrity: code, controllers, settings (a compromise shows up here first) ----
const integrity = {};
if (!EXPECT.routerHash || !EXPECT.helperHash) add('warn', 'Build files missing: canister code could not be compared with the repo');
for (const [name, id, want] of [['router', ROUTER, EXPECT.routerHash], ...HELPERS.map((h, i) => [`helper ${i}`, Principal.fromText(h), EXPECT.helperHash])]) {
  try {
    const st = await CanisterStatus.request({ canisterId: id, agent, paths: ['module_hash', 'controllers'] });
    const hash = st.get('module_hash');
    const ctrls = (st.get('controllers') || []).map((p) => p.toText()).sort();
    integrity[name] = { moduleHash: hash, controllers: ctrls };
    if (want && hash !== want) add('crit', `${name} is running different code than the repo build (unexpected upgrade?)`);
    if (JSON.stringify(ctrls) !== JSON.stringify(EXPECT.controllers)) add('crit', `${name} controllers changed: ${ctrls.join(', ')}`);
  } catch {
    add('warn', `Could not read ${name} code hash / controllers`);
  }
}
try {
  const cfgActor = Actor.createActor(
    ({ IDL }) => {
      const svc = routerIdl({ IDL });
      return IDL.Service({
        getConfig: svc._fields.find(([n]) => n === 'getConfig')[1],
        feeStatus: IDL.Func([], [IDL.Record({ bps: IDL.Nat, to: IDL.Principal })], ['query']),
        dustPayoutInfo: IDL.Func([], [IDL.Record({ to: IDL.Opt(IDL.Principal), minIcp: IDL.Nat })], ['query']),
      });
    },
    { agent, canisterId: ROUTER },
  );
  const cfg = await cfgActor.getConfig();
  const fee = await cfgActor.feeStatus();
  const dust = await cfgActor.dustPayoutInfo();
  integrity.config = {
    admin: cfg.admin.toText(),
    operators: cfg.operators.map((p) => p.toText()).sort(),
    feeTo: fee.to.toText(),
    feeBps: Number(fee.bps),
    dustTo: dust.to[0]?.toText() ?? null,
    dustMinIcp: Number(dust.minIcp) / 1e8,
    maxOrderIcp: Number(cfg.maxOrderIcp) / 1e8,
    minOrderIcp: Number(cfg.minOrderIcp) / 1e8,
    slippageBps: Number(cfg.slippageBps),
    maxImpactBps: Number(cfg.maxImpactBps),
    orderTtlSeconds: Number(cfg.orderTtlSeconds),
  };
  const c = integrity.config;
  if (c.slippageBps > EXPECT.maxSlippageBps || c.maxImpactBps > EXPECT.maxImpactBps) add('crit', `Price protection loosened: slippage ${c.slippageBps / 100}%, impact ${c.maxImpactBps / 100}%`);
  if (c.minOrderIcp < EXPECT.minOrderIcp || c.orderTtlSeconds > EXPECT.maxOrderTtlSeconds) add('warn', `Order limits changed: min ${c.minOrderIcp} ICP, window ${c.orderTtlSeconds / 60} min`);
  if (integrity.config.admin !== EXPECT.admin) add('crit', `Router admin changed to ${integrity.config.admin}`);
  if (JSON.stringify(integrity.config.operators) !== JSON.stringify(EXPECT.operators)) add('crit', `Router operators changed: ${integrity.config.operators.join(', ')}`);
  if (integrity.config.feeTo !== EXPECT.feeTo || integrity.config.feeBps !== EXPECT.feeBps) add('crit', `Fee changed: ${integrity.config.feeBps / 100}% to ${integrity.config.feeTo}`);
  if (c.dustTo !== EXPECT.dustTo) add('crit', `Dust payout wallet changed to ${c.dustTo ?? 'none'}`);
  if (integrity.config.maxOrderIcp !== EXPECT.maxOrderIcp) add('warn', `Max order changed to ${integrity.config.maxOrderIcp} ICP`);
} catch {
  add('warn', 'Could not read router settings');
}

const relay = await fetch(`${RELAY}/api/health`, { signal: AbortSignal.timeout(15_000) })
  .then((r) => r.json())
  .catch(() => null);
if (!relay) add('crit', 'Relay (swap site) not answering');
else {
  if (!relay.houdiniReady) add('crit', 'Houdini not connected on the relay');
  if (relay.routerError) add('crit', 'Relay cannot reach the router');
  // The swap site must point at this router and use the expected operator identity.
  if (relay.router !== ROUTER.toText()) add('crit', `Swap site points at a different router: ${relay.router ?? 'none'}`);
  if (!EXPECT.operators.includes(relay.operator)) add('crit', `Swap site uses an unexpected operator: ${relay.operator ?? 'none'}`);
}

if (relay && !/^[0-9a-f]{7,40}$/.test(String(relay.commit || ''))) add('crit', 'Swap site does not report its commit (every release does). Check Railway.');

// The hosting address must stay locked: only reachable through Cloudflare (pages redirect
// to the site, everything else is refused).
const ORIGIN = process.env.ORIGIN_URL || 'https://relay-production-e42e.up.railway.app';
if (ORIGIN !== 'off') {
  try {
    const page = await fetch(`${ORIGIN}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const api = await fetch(`${ORIGIN}/api/stats`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const toSite = page.status === 301 && String(page.headers.get('location') || '').startsWith(RELAY);
    integrity.originLock = toSite && api.status === 403 ? 'on' : { page: page.status, api: api.status };
    if (!(toSite && api.status === 403)) add('crit', `Hosting address answers directly (page ${page.status}, API ${api.status}): the Cloudflare-only lock is off.`);
  } catch {
    integrity.originLock = 'unreachable';
    add('warn', 'Could not check the hosting address lock (unreachable)');
  }
}

// The pages the site serves must be byte-for-byte this checkout's files: a changed swap page
// (e.g. fake deposit addresses after a hosting-account takeover) shows up here even when
// nothing changed on GitHub. A deploy in progress can differ for a minute or two, so a
// mismatch is re-checked once before it counts.
const PAGES = { '/': 'index.html', '/terms': 'terms.html', '/admin': 'admin/index.html', '/admin/app.js': 'admin/app.js' };
const pageSha = async (route) => {
  // Asked for like a browser: edge features that rewrite pages (analytics beacons, script
  // loaders) only act on browser requests.
  const r = await fetch(`${RELAY}${route}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      'cache-control': 'no-cache',
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
};
// Compare with the files of the commit the site says it runs (deploys are pinned, so the
// branch tip can be ahead of the live site); without git or a commit, with this checkout.
const deployed = /^[0-9a-f]{7,40}$/.test(String(relay?.commit || '')) ? relay.commit : null;
const git = (...a) => execFileSync('git', a, { cwd: here, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 });
let gitOk = false;
if (deployed) {
  try {
    git('fetch', '-q', 'origin');
  } catch {
    // offline or no remote: use what's here
  }
  try {
    git('cat-file', '-e', `${deployed}^{commit}`);
    gitOk = true;
    // Only commits on the live branch are ever released.
    try {
      git('fetch', '-q', 'origin', '+refs/heads/nakswap-v2-live:refs/remotes/origin/nakswap-v2-live');
    } catch {
      // offline: check against what's here
    }
    let haveBranch = true;
    try {
      git('rev-parse', '--verify', '-q', 'origin/nakswap-v2-live');
    } catch {
      haveBranch = false;
      add('warn', 'Could not check the deployed commit against the nakswap-v2-live branch (branch not fetched)');
    }
    if (haveBranch) {
      try {
        git('merge-base', '--is-ancestor', deployed, 'origin/nakswap-v2-live');
      } catch {
        add('crit', `Swap site runs commit ${deployed}, which isn't on the nakswap-v2-live branch. Pause the router and check Railway.`);
      }
    }
    if (process.env.EXPECT_RELAY_COMMIT && !deployed.startsWith(process.env.EXPECT_RELAY_COMMIT)) {
      add('warn', `Swap site runs ${deployed.slice(0, 7)}, expected ${process.env.EXPECT_RELAY_COMMIT.slice(0, 7)}`);
    }
  } catch {
    try {
      git('rev-parse', '--git-dir');
      add('crit', `Swap site runs commit ${deployed}, which isn't in the repo. Pause the router and check Railway.`);
    } catch {
      // not a git checkout: fall back to the files here
    }
  }
}
const localSha = (f) => {
  const bytes = gitOk ? git('show', `${deployed}:nakswap-v2/relay/public/${f}`) : fs.readFileSync(path.join(here, '..', 'public', f));
  return crypto.createHash('sha256').update(bytes).digest('hex');
};
const pageCheck = async () => {
  const bad = [];
  for (const [route, f] of Object.entries(PAGES)) {
    try {
      if ((await pageSha(route)) !== localSha(f)) bad.push(route);
    } catch {
      bad.push(`${route} (unreachable)`);
    }
  }
  return bad;
};
if (relay) {
  let bad = await pageCheck();
  if (bad.length) {
    await new Promise((r) => setTimeout(r, 90_000));
    bad = await pageCheck();
  }
  integrity.pages = bad.length ? { differ: bad, commit: deployed } : `match${gitOk ? ` (${deployed.slice(0, 7)})` : ''}`;
  if (bad.length) add('crit', `Swap site pages differ from the repo: ${bad.join(', ')}. If no deploy is running, the site may have been tampered with; pause the router and check Railway.`);
}

const level = alerts.some((a) => a.level === 'crit') ? 'crit' : alerts.some((a) => a.level === 'warn') ? 'warn' : 'ok';
const out = {
  at: new Date().toISOString(),
  level,
  alerts,
  status: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
  helpers,
  integrity,
  audits: audits.map((a) => ({ id: Number(a.id), at: new Date(Number(a.at / 1_000_000n)).toISOString(), note: a.note })),
};
console.log(JSON.stringify(out, null, 2));
process.exit(0);
