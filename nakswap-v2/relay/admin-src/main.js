// NAKSwap admin dashboard. Signs in with Internet Identity and talks to the canisters
// directly from the browser; the relay only serves this file.
import { AuthClient } from '@icp-sdk/auth/client';
import { Actor, HttpAgent, AnonymousIdentity } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { Principal } from '@icp-sdk/core/principal';

const HOST = 'https://icp-api.io';
const ROUTER = 'bkyfl-uyaaa-aaaab-qhl5q-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const NAK_LEDGER = 'eig2s-waaaa-aaaam-qbg5a-cai';
const POOL = 'd6hdt-qiaaa-aaaag-qm76q-cai';
const ICP_FEE = 10_000n;
const NAK_FEE = 1_000_000n;
const T = 1_000_000_000_000;

// ---------- Candid ----------
const routerIdl = ({ IDL }) => {
  const Health = IDL.Record({
    cycles: IDL.Nat,
    lowCyclesThreshold: IDL.Nat,
    acceptingOrders: IDL.Bool,
    paused: IDL.Bool,
    activeOrders: IDL.Nat,
    nextOrderId: IDL.Nat,
    feeBps: IDL.Nat,
    helpers: IDL.Nat,
  });
  const HelperInfo = IDL.Record({ helper: IDL.Principal, busy: IDL.Bool, quarantined: IDL.Bool, holdsOrder: IDL.Opt(IDL.Nat) });
  const OrderLine = IDL.Record({ id: IDL.Nat, status: IDL.Text, createdAt: IDL.Int, icpIn: IDL.Nat, nakOut: IDL.Nat, detail: IDL.Text });
  const FeeSweep = IDL.Record({ gross: IDL.Nat, amount: IDL.Nat, to: IDL.Principal, createdAtTime: IDL.Nat64 });
  const FeeStatus = IDL.Record({
    bps: IDL.Nat,
    to: IDL.Principal,
    accrued: IDL.Nat,
    paidTotal: IDL.Nat,
    stuck: IDL.Nat,
    pending: IDL.Opt(FeeSweep),
    autoSweepAt: IDL.Nat,
  });
  const Overview = IDL.Record({
    health: Health,
    maxOpenOrders: IDL.Nat,
    counts: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Nat)),
    ordersLastHour: IDL.Nat,
    review: IDL.Vec(OrderLine),
    recent: IDL.Vec(OrderLine),
    helpers: IDL.Vec(HelperInfo),
    fees: FeeStatus,
    ordersWithHelperFunds: IDL.Nat,
    straySubaccount: IDL.Vec(IDL.Nat8),
  });
  const Role = IDL.Variant({ controller: IDL.Null, admin: IDL.Null, guardian: IDL.Null, operator: IDL.Null, none: IDL.Null });
  return IDL.Service({
    myRole: IDL.Func([], [Role], ['query']),
    adminOverview: IDL.Func([], [IDL.Opt(Overview)], ['query']),
    setPaused: IDL.Func([IDL.Bool], [IDL.Bool], []),
    runRecovery: IDL.Func([], [], []),
    checkLateDeposits: IDL.Func([], [IDL.Nat], []),
    publicStats: IDL.Func([], [IDL.Record({ swaps: IDL.Nat, icpSwapped: IDL.Nat, nakDelivered: IDL.Nat, lateWatched: IDL.Nat })], ['query']),
    requestAudit: IDL.Func([IDL.Text], [IDL.Opt(IDL.Nat)], []),
    auditRequests: IDL.Func([], [IDL.Vec(IDL.Record({ id: IDL.Nat, at: IDL.Int, note: IDL.Text }))], ['query']),
  });
};
const helperIdl = ({ IDL }) =>
  IDL.Service({ health: IDL.Func([], [IDL.Record({ cycles: IDL.Nat, busy: IDL.Bool, lastClean: IDL.Bool })], ['query']) });
const ledgerIdl = ({ IDL }) =>
  IDL.Service({
    icrc1_balance_of: IDL.Func([IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) })], [IDL.Nat], ['query']),
  });
const poolIdl = ({ IDL }) => {
  const Err = IDL.Variant({ CommonError: IDL.Null, InsufficientFunds: IDL.Null, InternalError: IDL.Text, UnsupportedToken: IDL.Text });
  return IDL.Service({
    getTransactionsByOwner: IDL.Func([IDL.Principal], [IDL.Variant({ ok: IDL.Vec(IDL.Tuple(IDL.Nat, IDL.Reserved)), err: Err })], ['query']),
    getUserUnusedBalance: IDL.Func([IDL.Principal], [IDL.Variant({ ok: IDL.Record({ balance0: IDL.Nat, balance1: IDL.Nat }), err: Err })], ['query']),
  });
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const e8 = (n) => Number(n) / 1e8;
const fmt = (n, d = 4) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const short = (p) => {
  const t = String(p);
  return t.length > 20 ? `${t.slice(0, 11)}…${t.slice(-7)}` : t;
};
const ago = (ns) => {
  const s = Math.max(0, (Date.now() - Number(BigInt(ns) / 1_000_000n)) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const auth = new AuthClient();
let agent = null;
let router = null;
let role = 'none';
let refreshTimer = null;

async function connect(identity) {
  agent = await HttpAgent.create({ host: HOST, identity });
  router = Actor.createActor(routerIdl, { agent, canisterId: ROUTER });
}
const anon = async () => HttpAgent.create({ host: HOST, identity: new AnonymousIdentity() });

// ---------- sign in ----------
async function signIn() {
  $('signin').disabled = true;
  try {
    const identity = await auth.signIn({ maxTimeToLive: BigInt(8 * 3600) * 1_000_000_000n });
    await start(identity);
  } catch (e) {
    $('authMsg').textContent = `Sign-in failed: ${e.message}`;
  } finally {
    $('signin').disabled = false;
  }
}

async function signOut() {
  clearInterval(refreshTimer);
  await auth.signOut();
  location.reload();
}

async function start(identity) {
  await connect(identity);
  const me = identity.getPrincipal().toText();
  $('welcome').hidden = true;
  $('me').textContent = me;
  $('meBox').hidden = false;
  $('signin').hidden = true;
  $('signout').hidden = false;
  role = Object.keys(await router.myRole())[0];
  $('role').textContent = role;
  if (role === 'none' || role === 'operator') {
    $('unauth').hidden = false;
    $('dash').hidden = true;
    return;
  }
  $('unauth').hidden = true;
  $('dash').hidden = false;
  await refresh();
  refreshTimer = setInterval(refresh, 30_000);
}

// ---------- data ----------
async function collect() {
  const a = await anon();
  const icp = Actor.createActor(ledgerIdl, { agent: a, canisterId: ICP_LEDGER });
  const nak = Actor.createActor(ledgerIdl, { agent: a, canisterId: NAK_LEDGER });
  const pool = Actor.createActor(poolIdl, { agent: a, canisterId: POOL });
  const ov = (await router.adminOverview())[0];
  if (!ov) throw new Error('not authorized for the overview');
  const routerP = Principal.fromText(ROUTER);
  const stray = { owner: routerP, subaccount: [ov.straySubaccount] };
  const poolState = async (p) => {
    const [tx, un] = await Promise.all([pool.getTransactionsByOwner(p), pool.getUserUnusedBalance(p)]);
    return { pending: 'ok' in tx ? tx.ok.length : -1, unusedIcp: 'ok' in un ? un.ok.balance1 : 0n, unusedNak: 'ok' in un ? un.ok.balance0 : 0n };
  };
  const helpers = await Promise.all(
    ov.helpers.map(async (h) => {
      const ha = Actor.createActor(helperIdl, { agent: a, canisterId: h.helper });
      const acct = { owner: h.helper, subaccount: [] };
      const [hh, bi, bn, ps] = await Promise.all([
        ha.health().catch(() => null),
        icp.icrc1_balance_of(acct),
        nak.icrc1_balance_of(acct),
        poolState(h.helper).catch(() => ({ pending: -1, unusedIcp: 0n, unusedNak: 0n })),
      ]);
      return { ...h, health: hh, icp: bi, nak: bn, pool: ps };
    }),
  );
  const [mainIcp, mainNak, strayIcp, strayNak, routerPool, relay, audits] = await Promise.all([
    icp.icrc1_balance_of({ owner: routerP, subaccount: [] }),
    nak.icrc1_balance_of({ owner: routerP, subaccount: [] }),
    icp.icrc1_balance_of(stray),
    nak.icrc1_balance_of(stray),
    poolState(routerP).catch(() => ({ pending: -1, unusedIcp: 0n, unusedNak: 0n })),
    fetch('/api/health').then((r) => r.json()).catch(() => null),
    router.auditRequests(),
  ]);
  // Totals and the late-deposit watch (a router built before them answers with an error).
  const stats = await router.publicStats().catch(() => null);
  return { ov, helpers, mainIcp, mainNak, strayIcp, strayNak, routerPool, relay, audits, stats };
}

// Rules for "something looks wrong". Each: [level, text].
function alertsFor(d) {
  const out = [];
  const h = d.ov.health;
  const cyc = Number(h.cycles) / T;
  if (h.paused) out.push(['warn', 'Swaps are frozen (paused). New orders are refused; payouts and refunds already in flight still complete.']);
  if (cyc < 0.5) out.push(['crit', `Router cycles critically low: ${cyc.toFixed(2)}T. It stops taking orders below 0.5T. Top up now.`]);
  else if (cyc < 1.5) out.push(['warn', `Router cycles getting low: ${cyc.toFixed(2)}T.`]);
  for (const [i, x] of d.helpers.entries()) {
    const hc = x.health ? Number(x.health.cycles) / T : null;
    if (hc === null) out.push(['crit', `Helper ${i} is not answering (stopped or out of cycles?).`]);
    else if (hc < 0.1) out.push(['crit', `Helper ${i} cycles critically low: ${hc.toFixed(2)}T.`]);
    else if (hc < 0.3) out.push(['warn', `Helper ${i} cycles getting low: ${hc.toFixed(2)}T.`]);
    if (x.quarantined) out.push(['warn', `Helper ${i} is out of rotation${x.holdsOrder.length ? ` holding order #${x.holdsOrder[0]}` : ''}. It recovers on its own once ICPSwap finishes.`]);
    if (!x.busy && (x.icp > ICP_FEE || x.nak > NAK_FEE)) out.push(['warn', `Helper ${i} holds funds while idle (${fmt(e8(x.icp))} ICP, ${fmt(e8(x.nak), 2)} NAK).`]);
    if (x.pool.pending > 0) out.push([x.busy ? 'info' : 'warn', `ICPSwap has ${x.pool.pending} pending or failed transaction(s) for helper ${i}.`]);
  }
  if (d.routerPool.pending > 0) out.push(['warn', `ICPSwap has ${d.routerPool.pending} pending or failed transaction(s) for the router.`]);
  const review = d.ov.counts.find(([t]) => t === 'needsReview')?.[1] ?? 0n;
  if (review > 0n) out.push(['warn', `${review} order(s) need review (listed below).`]);
  if (d.ov.fees.stuck > 0n) out.push(['warn', `${fmt(e8(d.ov.fees.stuck))} ICP of fees has an unknown outcome (check the ledger, then resolveStuckFees).`]);
  const open = Number(h.activeOrders);
  const cap = Number(d.ov.maxOpenOrders);
  if (open >= cap * 0.9) out.push(['crit', `${open} of ${cap} open orders: new orders are about to be refused. Possible spam.`]);
  else if (open >= cap * 0.6) out.push(['warn', `${open} of ${cap} open orders. Unusually many waiting deposits.`]);
  if (Number(d.ov.ordersLastHour) > 60) out.push(['warn', `${d.ov.ordersLastHour} orders in the last hour: unusual volume.`]);
  if (d.strayIcp > ICP_FEE || d.strayNak > NAK_FEE) out.push(['info', `Someone sent funds to a helper: ${fmt(e8(d.strayIcp))} ICP, ${fmt(e8(d.strayNak), 2)} NAK set aside in the stray account.`]);
  if (!d.relay) out.push(['crit', 'The relay (swap site API) is not answering.']);
  else {
    if (!d.relay.houdiniReady) out.push(['crit', 'Houdini is not connected: tokens and quotes are unavailable.']);
    if (d.relay.routerError) out.push(['crit', 'The relay cannot reach the router.']);
  }
  return out;
}

function render(d) {
  const { ov } = d;
  const h = ov.health;
  const alerts = alertsFor(d);
  const level = alerts.some(([l]) => l === 'crit') ? 'crit' : alerts.some(([l]) => l === 'warn') ? 'warn' : 'ok';
  $('overall').className = `overall ${level}`;
  $('overallText').textContent = level === 'ok' ? 'All clear' : level === 'warn' ? 'Needs attention' : 'Action needed';
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  $('alerts').innerHTML = alerts.length
    ? alerts.map(([l, t]) => `<li class="${l}"><span class="tag">${l === 'crit' ? 'Critical' : l === 'warn' ? 'Warning' : 'Info'}</span>${esc(t)}</li>`).join('')
    : '<li class="ok"><span class="tag">OK</span>No unusual behaviour detected.</li>';

  $('freeze').hidden = h.paused;
  $('unfreeze').hidden = !h.paused;
  $('stateText').textContent = h.paused ? 'Frozen' : h.acceptingOrders ? 'Live' : 'Not accepting orders';
  $('stateText').className = h.paused ? 'bad' : h.acceptingOrders ? 'good' : 'bad';

  const tiles = [
    ['Router cycles', `${(Number(h.cycles) / T).toFixed(2)}T`],
    ['Open orders', `${h.activeOrders} / ${ov.maxOpenOrders}`],
    ['Orders, last hour', String(ov.ordersLastHour)],
    ['Total orders', String(h.nextOrderId)],
    ['Fee earned, sent', `${fmt(e8(ov.fees.paidTotal))} ICP`],
    ['Fee waiting', `${fmt(e8(ov.fees.accrued))} ICP`],
    ...(d.stats ? [['Swaps completed', String(d.stats.swaps)], ['NAK delivered', fmt(e8(d.stats.nakDelivered))], ['Watched for late ICP', String(d.stats.lateWatched)]] : []),
  ];
  $('tiles').innerHTML = tiles.map(([k, v]) => `<div class="tile"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

  $('counts').innerHTML = ov.counts.map(([t, n]) => `<div class="count${n > 0n && t === 'needsReview' ? ' hot' : ''}"><span>${esc(t)}</span><b>${n}</b></div>`).join('');

  $('helpers').innerHTML = d.helpers
    .map(
      (x, i) => `<tr>
        <td>${i}</td><td class="mono" title="${esc(x.helper.toText())}">${esc(short(x.helper.toText()))}</td>
        <td>${x.health ? (Number(x.health.cycles) / T).toFixed(2) + 'T' : '<span class="bad">no answer</span>'}</td>
        <td>${x.quarantined ? `<span class="bad">paused${x.holdsOrder.length ? ` (#${x.holdsOrder[0]})` : ''}</span>` : x.busy ? '<span class="good">swapping</span>' : 'idle'}</td>
        <td>${fmt(e8(x.icp))} ICP · ${fmt(e8(x.nak), 2)} NAK</td>
        <td>${x.pool.pending < 0 ? '?' : x.pool.pending}</td>
      </tr>`,
    )
    .join('');

  const row = (o) => `<tr>
      <td>#${o.id}</td><td>${esc(o.status)}</td><td>${ago(o.createdAt)}</td>
      <td>${o.icpIn > 0n ? fmt(e8(o.icpIn)) + ' ICP' : ''}</td><td>${o.nakOut > 0n ? fmt(e8(o.nakOut), 0) + ' NAK' : ''}</td>
      <td class="detail">${esc(o.detail)}</td></tr>`;
  $('review').innerHTML = ov.review.length ? ov.review.map(row).join('') : '<tr><td colspan="6" class="muted">None.</td></tr>';
  $('recent').innerHTML = ov.recent.length ? ov.recent.map(row).join('') : '<tr><td colspan="6" class="muted">No orders yet.</td></tr>';

  $('money').innerHTML = `
    <dt>Router main account</dt><dd>${fmt(e8(d.mainIcp))} ICP · ${fmt(e8(d.mainNak), 2)} NAK</dd>
    <dt>Stray account (sent to helpers)</dt><dd>${fmt(e8(d.strayIcp))} ICP · ${fmt(e8(d.strayNak), 2)} NAK</dd>
    <dt>ICPSwap pending for router</dt><dd>${d.routerPool.pending < 0 ? '?' : d.routerPool.pending}</dd>
    <dt>Orders with funds at a helper</dt><dd>${ov.ordersWithHelperFunds}</dd>
    <dt>Fee rate · wallet</dt><dd>${Number(ov.fees.bps) / 100}% · <span class="mono">${esc(short(ov.fees.to.toText()))}</span></dd>
    <dt>Relay</dt><dd>${d.relay ? `${d.relay.houdiniReady ? 'Houdini connected' : 'Houdini NOT connected'} · ICP $${fmt(d.relay.prices?.icpUsd ?? 0, 2)}` : 'not answering'}</dd>`;

  $('audits').innerHTML = d.audits.length
    ? [...d.audits]
        .sort((x, y) => Number(y.id - x.id))
        .slice(0, 10)
        .map((r) => `<li><b>#${r.id}</b> ${ago(r.at)}${r.note ? ` · ${esc(r.note)}` : ''}</li>`)
        .join('')
    : '<li class="muted">No audit requests yet.</li>';
}

async function refresh() {
  try {
    render(await collect());
    $('err').textContent = '';
  } catch (e) {
    $('err').textContent = `Refresh failed: ${e.message}`;
  }
}

// ---------- actions ----------
async function setFrozen(frozen) {
  const msg = frozen
    ? 'Freeze NAKSwap? New orders and new swaps stop immediately. Payouts and refunds already in progress still finish.'
    : 'Unfreeze NAKSwap and resume taking orders?';
  if (!confirm(msg)) return;
  const b = frozen ? $('freeze') : $('unfreeze');
  b.disabled = true;
  try {
    const ok = await router.setPaused(frozen);
    if (!ok) alert('The router refused: this identity is not allowed to do that.');
  } catch (e) {
    alert(`Failed: ${e.message}`);
  } finally {
    b.disabled = false;
    refresh();
  }
}

async function recover() {
  $('recover').disabled = true;
  try {
    await router.runRecovery();
    // Also look for ICP that arrived after an order expired (it revives that order).
    await router.checkLateDeposits();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  } finally {
    $('recover').disabled = false;
    refresh();
  }
}

async function requestAudit() {
  const note = $('auditNote').value.trim().slice(0, 280);
  $('auditBtn').disabled = true;
  try {
    const r = await router.requestAudit(note);
    $('auditMsg').textContent = r.length
      ? `Audit #${r[0]} requested. Claude picks it up within 2 hours and sends you the report.`
      : 'Not accepted: one request per 10 minutes.';
    $('auditNote').value = '';
  } catch (e) {
    $('auditMsg').textContent = `Failed: ${e.message}`;
  } finally {
    $('auditBtn').disabled = false;
    refresh();
  }
}

// ---------- boot ----------
$('signin').addEventListener('click', signIn);
$('signout').addEventListener('click', signOut);
$('freeze').addEventListener('click', () => setFrozen(true));
$('unfreeze').addEventListener('click', () => setFrozen(false));
$('recover').addEventListener('click', recover);
$('refresh').addEventListener('click', refresh);
$('auditBtn').addEventListener('click', requestAudit);
$('copyMe').addEventListener('click', () => navigator.clipboard?.writeText($('me').textContent));
(async () => {
  try {
    // Local testing only: a build with __TEST_SEED__ defined signs in with that key instead
    // of Internet Identity. The production build sets it to null.
    if (typeof __TEST_SEED__ !== 'undefined' && __TEST_SEED__) {
      const { Ed25519KeyIdentity } = await import('@icp-sdk/core/identity');
      await start(Ed25519KeyIdentity.generate(Uint8Array.from(__TEST_SEED__.match(/../g).map((h) => parseInt(h, 16)))));
      return;
    }
    if (auth.isAuthenticated()) await start(await auth.getIdentity());
  } catch {
    // stay on the sign-in screen
  }
})();
