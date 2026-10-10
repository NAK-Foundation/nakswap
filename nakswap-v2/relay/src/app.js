// HTTP API + swap page for NAKSwap v2. Pure request handling; houdini and ic clients are
// injected so the same code runs live, against mocks, and in tests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ORDER_STATUS } from './houdini.js';

const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Sent with every response. The page's own script and styles are inline, fonts come from
// Google Fonts and token icons from Houdini's CDN; nothing may frame the page.
// The page's one inline script is allowed by its hash (computed at startup), so an injected
// script tag would not run even if some text were ever left unescaped.
const SCRIPT_HASH = (() => {
  try {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    return m ? `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'` : "'none'";
  } catch {
    return "'none'";
  }
})();

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    `script-src 'self' ${SCRIPT_HASH}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://api.houdiniswap.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// The admin dashboard (/admin) talks to the Internet Computer from the browser and signs in
// with Internet Identity in a popup, so it needs IC hosts in connect-src and a COOP that
// keeps the popup's opener link. Its script is a same-origin file (no inline script).
const ADMIN_HEADERS = {
  ...SECURITY_HEADERS,
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' https://icp-api.io https://icp0.io https://*.icp0.io https://ic0.app https://*.ic0.app https://id.ai https://*.id.ai",
    "frame-src https://id.ai https://*.id.ai",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

const json = (res, code, body) => {
  // No CORS headers: the API is for this page only (same origin), so other sites can't
  // spend the Houdini quota or open orders through it from a visitor's browser.
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify(body, (_, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object' && v._isPrincipal) return v.toText();
      return v;
    }),
  );
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8_192) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const v = data ? JSON.parse(data) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
  });

// Client IP. Railway's edge sets X-Real-IP; the left end of X-Forwarded-For is whatever the
// client typed, so it is never trusted (it would let anyone dodge the rate limits).
function userContext(req) {
  const real = req.headers['x-real-ip'];
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = (typeof real === 'string' && real.trim()) || fwd[fwd.length - 1] || req.socket?.remoteAddress || '0.0.0.0';
  const tz = String(req.headers['x-user-timezone'] || 'UTC');
  // IPv6 clients usually control a whole /64, so limit per /64 rather than per address.
  const key = ip.includes(':') && !ip.includes('.') ? `${ip.split(':').slice(0, 3).join(':')}::/48` : ip;
  return {
    ip: key.slice(0, 64),
    agent: String(req.headers['user-agent'] || 'unknown').slice(0, 256),
    timezone: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : 'UTC',
  };
}

// Input shapes accepted from the page; anything else is rejected before it reaches Houdini
// or the router.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ADDR_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const AMOUNT_RE = /^\d{1,15}(\.\d{1,18})?$/;
const KEY_RE = /^[0-9a-f]{20}$/;
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

// Houdini quotes the relay handed out, so orders can only be placed against a real, current,
// unblocked quote — and the relay, not the browser, decides the minimum NAK to protect.
const QUOTE_TTL_MS = 3 * 60_000;
// Guaranteed minimum = quoted NAK minus this much. Covers Houdini delivering a little less
// ICP than estimated plus normal price drift during the 5–45 min Houdini leg; anything
// worse (e.g. someone pushing the price just before the router buys) is refunded in ICP.
const MIN_OUT_TOLERANCE_BPS = 600n;

// Small fixed-window limiter (each order costs a canister call and a Houdini exchange).
// Old windows are dropped as it goes, so a flood of addresses can't grow it without bound.
function limiter(max, windowMs) {
  const hits = new Map();
  let lastSweep = Date.now();
  return (key) => {
    const now = Date.now();
    if (now - lastSweep > windowMs || hits.size > 50_000) {
      for (const [k, h] of hits) if (now - h.start > windowMs) hits.delete(k);
      lastSweep = now;
      if (hits.size > 50_000) hits.clear();
    }
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}

const statusName = (s) => Object.keys(s)[0];

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/admin' || pathname === '/admin/' ? 'admin/index.html' : pathname.replace(/^\/+/, '');
  const isAdminPage = rel === 'admin/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, {
    ...(isAdminPage ? ADMIN_HEADERS : SECURITY_HEADERS),
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': isAdminPage ? 'no-store' : rel === 'index.html' || rel.startsWith('admin/') ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}

// Houdini's floor for standard and private routes, in USD (it rejects quotes below this).
export const HOUDINI_MIN_USD = 25;

// Order links carry a key derived from the relay's secret, so order numbers (which count up)
// can't be used to look through other people's orders.
export function orderKey(secret, id) {
  return crypto.createHmac('sha256', secret).update(`order:${id}`).digest('hex').slice(0, 20);
}

export function createApp({
  houdini,
  ic,
  prices = {},
  log = () => {},
  secret = crypto.randomBytes(32),
  pokeEveryMs = 15_000,
  houdiniCacheMs = 5_000,
  quoteCacheMs = 20_000,
  // Site-wide orders per hour. 150 keeps well inside the router's 150 open-order cap (orders
  // stay open ~5-45 min while Houdini works) and its ~120-180 swaps/hour throughput.
  orderLimitPerHour = 150,
  cleanupEveryMs = 5 * 60_000,
}) {
  // Per visitor IP, plus global ceilings so many addresses together still can't flood the
  // router with orders or burn the Houdini quote allowance.
  const allowOrder = limiter(5, 10 * 60_000);
  const allowOrderGlobal = limiter(orderLimitPerHour, 60 * 60_000);
  const allowQuote = limiter(30, 60_000);
  // Site-wide quote ceiling, so many addresses together can't use up the Houdini quota.
  const allowQuoteGlobal = limiter(1_200, 60 * 60_000);
  // Orders this relay opened that are still waiting for a deposit (lost on restart; the
  // router's own TTL is the backstop). Used to cap open orders per visitor and to cancel
  // orders whose Houdini exchange expired or failed.
  const openOrders = new Map(); // id -> { houdiniId, at, ip, user }
  const MAX_OPEN_PER_IP = 5;
  const allowView = limiter(120, 60_000);
  const allowTokens = limiter(60, 60_000);
  const quoteCache = new Map(); // ip|fromId|amount|refund -> { at, result }
  const issued = new Map(); // quoteId -> { at, blocked, nakOut }
  const houdiniCache = new Map(); // houdiniId -> { at, h }
  const lastPoke = new Map(); // order id -> ms
  let tokenCache = { at: 0, term: null, tokens: [] };

  async function tokens(term, user) {
    const key = (term || '').toLowerCase();
    if (tokenCache.term === key && Date.now() - tokenCache.at < 10 * 60_000) return tokenCache.tokens;
    const list = (await houdini.searchTokens(key, user)).map((t) => ({
      id: t.id,
      symbol: t.symbol,
      name: t.name,
      chain: t.chain,
      chainName: t.chainData?.name || t.network?.name || t.chain,
      chainType: t.chainData?.type || t.chainData?.kind || null,
      icon: t.icon || null,
      decimals: t.decimals,
      usd: Number(t.price) > 0 ? Number(t.price) : null,
    }));
    if (!key) tokenCache = { at: Date.now(), term: key, tokens: list };
    return list;
  }

  async function quote(body, user) {
    const cfg = ic.config;
    const fromId = str(body.fromId);
    const amount = str(body.amount);
    const refundAddress = body.refundAddress == null || body.refundAddress === '' ? '' : str(body.refundAddress);
    if (!fromId || !amount || !(Number(amount) > 0)) return [400, { error: 'fromId and a positive amount are required' }];
    if (!ID_RE.test(fromId) || !AMOUNT_RE.test(amount)) return [400, { error: 'invalid token or amount' }];
    if (refundAddress === null || (refundAddress && !ADDR_RE.test(refundAddress))) return [400, { error: 'invalid refund address' }];
    if (!allowQuote(user.ip)) return [429, { error: 'too many quote requests, slow down' }];
    if (!allowQuoteGlobal('all')) return [503, { error: 'NAKSwap is very busy right now. Please try again in a few minutes.' }];
    // Same token + amount within a few seconds (typing, re-renders): reuse the last answer
    // instead of spending another Houdini quote request.
    // Per visitor: quote ids are never handed to two different people.
    const qKey = `${user.ip}|${fromId}|${amount}|${refundAddress}`;
    const cached = quoteCache.get(qKey);
    if (cached && Date.now() - cached.at < quoteCacheMs) return [200, cached.result];
    for (const [k, v] of quoteCache) if (Date.now() - v.at >= quoteCacheMs) quoteCache.delete(k);
    const all = await houdini.quotesToIcp({ fromId, amount, refundAddress: refundAddress || undefined, user });
    // Houdini can return dozens of routes; show the best Standard and the best Private one.
    const best = new Map();
    for (const q of all) {
      if (q.error || q.filtered || !(Number(q.amountOut) > 0)) continue;
      const cur = best.get(q.type);
      if (!cur || Number(q.amountOut) > Number(cur.amountOut)) best.set(q.type, q);
    }
    const quotes = [...best.values()];
    // Route types Houdini didn't give a usable quote for, with its reason when it gave one,
    // so the page can say why (e.g. Private needs a larger amount) instead of hiding it.
    const unavailable = [];
    for (const type of ['standard', 'private']) {
      if (best.has(type)) continue;
      const tried = all.filter((q) => q.type === type);
      const min = tried.map((q) => Number(q.min)).filter((n) => n > 0).sort((x, y) => x - y)[0];
      const why = tried.map((q) => (typeof q.error === 'string' ? q.error : q.error?.message)).find(Boolean);
      unavailable.push({
        type,
        reason: min && Number(amount) < min ? `needs at least ${min} for this token` : why ||
            (type === 'private'
              ? 'Houdini didn’t offer one at this amount. Private routes usually need a larger swap, often $40 or more'
              : 'Houdini didn’t offer one at this amount right now'),
      });
    }
    const routes = [];
    for (const q of quotes) {
      const icpE8s = BigInt(Math.floor(Number(q.amountOut) * 1e8));
      if (icpE8s <= 0n) continue;
      const p = await ic.previewSwap(icpE8s);
      let blocked = null;
      if (q.min && Number(amount) < Number(q.min)) blocked = `Houdini minimum for this route is ${q.min}`;
      else if (q.max && Number(amount) > Number(q.max)) blocked = `Houdini maximum for this route is ${q.max}`;
      else if (icpE8s < cfg.minOrderIcp) blocked = `below the router minimum of ${Number(cfg.minOrderIcp) / 1e8} ICP`;
      else if (icpE8s > cfg.maxOrderIcp) blocked = `above the router maximum of ${Number(cfg.maxOrderIcp) / 1e8} ICP`;
      else if (p.impactBps > cfg.maxImpactBps) blocked = `price impact ${Number(p.impactBps) / 100}% is too high`;
      routes.push({
        quoteId: q.quoteId,
        type: q.type,
        provider: q.swapName || (q.type === 'private' ? 'Private route' : 'Standard route'),
        logoUrl: q.logoUrl || null,
        etaMinutes: q.duration,
        icpOut: icpE8s,
        nakswapFeeIcp: p.nakswapFee,
        nakOut: p.nakOut,
        minNakOut: p.minNakOut,
        guaranteedNak: (p.nakOut * (10_000n - MIN_OUT_TOLERANCE_BPS)) / 10_000n,
        impactBps: p.impactBps,
        requiresRefundAddress: Boolean(q.requiresRefundAddress),
        amountInUsd: q.amountInUsd ?? null,
        blocked,
      });
    }
    routes.sort((a, b) => {
      if (!a.blocked !== !b.blocked) return a.blocked ? 1 : -1;
      return b.nakOut > a.nakOut ? 1 : b.nakOut < a.nakOut ? -1 : 0;
    });
    const result = {
      routes,
      unavailable,
      quotedAt: Date.now(),
      router: { ready: Boolean(ic.routerId), slippageBps: cfg.slippageBps, maxImpactBps: cfg.maxImpactBps },
    };
    quoteCache.set(qKey, { at: Date.now(), result });
    for (const [k, v] of issued) if (Date.now() - v.at > QUOTE_TTL_MS) issued.delete(k);
    if (issued.size > 20_000) issued.clear();
    for (const r of routes) issued.set(String(r.quoteId), { at: Date.now(), blocked: r.blocked, nakOut: BigInt(r.nakOut) });
    return [200, result];
  }

  async function createOrder(body, user) {
    const quoteId = str(body.quoteId);
    const recipient = str(body.recipient);
    const refundTo = body.refundTo == null || body.refundTo === '' ? null : str(body.refundTo);
    const refundAddress = body.refundAddress == null || body.refundAddress === '' ? '' : str(body.refundAddress);
    if (!quoteId) return [400, { error: 'quoteId is required' }];
    if (!ID_RE.test(quoteId)) return [400, { error: 'invalid quoteId' }];
    if (refundAddress === null || (refundAddress && !ADDR_RE.test(refundAddress))) return [400, { error: 'invalid refund address' }];
    let recipientP, refundToP;
    try {
      recipientP = ic.parsePrincipal(recipient);
      refundToP = refundTo ? ic.parsePrincipal(refundTo) : null;
    } catch (e) {
      return [400, { error: `invalid principal: ${e.message}` }];
    }
    if (!allowOrder(user.ip)) return [429, { error: 'Too many orders from your connection. Wait a few minutes and try again.' }];
    if ([...openOrders.values()].filter((o) => o.ip === user.ip).length >= MAX_OPEN_PER_IP) {
      return [429, { error: 'You already have several swaps waiting for a deposit. Finish or let them expire first.' }];
    }
    const q = issued.get(quoteId);
    if (!q || Date.now() - q.at > QUOTE_TTL_MS) return [409, { error: 'That quote has expired. Get a fresh quote and try again.' }];
    if (q.blocked) return [400, { error: `That route can't be used: ${q.blocked}.` }];
    if (!allowOrderGlobal('all')) return [503, { error: 'NAKSwap is very busy right now. Please try again in a little while.' }];
    issued.delete(quoteId); // one order per quote
    const minNakOut = (q.nakOut * (10_000n - MIN_OUT_TOLERANCE_BPS)) / 10_000n;

    // 1. Router order first: it mints the deposit account Houdini will pay into.
    const order = await ic.createOrder({
      recipient: recipientP,
      refundTo: refundToP,
      minNakOut: minNakOut > 0n ? minNakOut : null,
    });
    // 2. Houdini exchange paying ICP to that account.
    let ex;
    try {
      ex = await houdini.createExchange({
        quoteId,
        addressTo: order.depositAccountId,
        refundAddress: refundAddress || undefined,
        user,
      });
    } catch (e) {
      log('houdini createExchange failed', { order: order.id.toString(), status: e.status ?? null });
      throw Object.assign(new Error(`Houdini did not accept the order: ${e.message}`), { status: e.status === 422 ? 422 : 502, expose: true });
    }
    // Don't show a deposit address unless Houdini's exchange is the one we asked for: ICP,
    // paid to this order's deposit account. If not, the user is never told where to send,
    // and the unpaired router order is cleaned up after 15 minutes.
    const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/^0x/, '');
    const fail = (why) => {
      log('houdini exchange rejected', { order: order.id.toString(), why });
      return Object.assign(new Error('Houdini returned an unexpected exchange, so nothing was set up. Please get a new quote and try again.'), { status: 502, expose: true });
    };
    if (!ex || !ex.houdiniId || !ex.depositAddress) throw fail('incomplete response');
    if (ex.receiverAddress != null && norm(ex.receiverAddress) !== norm(order.depositAccountId)) throw fail('destination mismatch');
    if (ex.outSymbol != null && String(ex.outSymbol).toUpperCase() !== 'ICP') throw fail('output is not ICP');
    // 3. Link them so support can trace either side. If that fails, the router would treat
    // the order as unpaired and clean it up, so don't hand out the deposit address.
    const attached = await ic.attachHoudini(order.id, String(ex.houdiniId));
    if (attached !== true) throw fail('attach failed');
    // Privacy: logs keep only the order number; no principals, addresses, amounts or IPs.
    log('order', { id: order.id.toString() });
    openOrders.set(order.id.toString(), { houdiniId: String(ex.houdiniId), at: Date.now(), ip: user.ip, user });
    return [
      201,
      {
        orderId: order.id,
        orderKey: orderKey(secret, order.id),
        houdiniId: ex.houdiniId,
        send: {
          amount: ex.inAmount,
          symbol: ex.inSymbol,
          chain: ex.inToken?.chain ?? null,
          to: ex.depositAddress,
          tag: ex.depositTag ?? null,
          expires: ex.expires,
        },
        expectedIcp: ex.outAmount,
        guaranteedNak: minNakOut,
        icpDepositAccount: order.depositAccountId,
        nakRecipient: recipientP.toText(),
        rerouted: ex.rerouted ?? false,
      },
    ];
  }

  async function getOrder(id, key, user) {
    if (!allowView(user.ip)) return [429, { error: 'too many requests, slow down' }];
    const given = typeof key === 'string' ? key : '';
    if (id.length > 20 || !KEY_RE.test(given) || !crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(orderKey(secret, id), 'hex'))) {
      return [404, { error: 'order not found. Use the full order code, e.g. 12-ab34…' }];
    }
    const order = await ic.getOrder(BigInt(id));
    if (!order) return [404, { error: 'order not found' }];
    let hd = null;
    const houdiniId = order.houdiniId[0];
    if (houdiniId) {
      try {
        // Several open tabs polling the same order share one Houdini lookup.
        let h;
        const c = houdiniCache.get(houdiniId);
        if (c && Date.now() - c.at < houdiniCacheMs) h = c.h;
        else {
          h = await houdini.getOrder(houdiniId, user);
          houdiniCache.set(houdiniId, { at: Date.now(), h });
          if (houdiniCache.size > 5_000) houdiniCache.clear();
        }
        hd = {
          houdiniId,
          status: h.status,
          statusLabel: h.displayStatus || h.statusLabel || ORDER_STATUS[h.status],
          eta: h.eta,
          send: { amount: h.inAmount, symbol: h.inSymbol, to: h.depositAddress, tag: h.depositTag ?? null, expires: h.expires },
          outAmount: h.outAmount,
          anonymous: h.anonymous ?? false,
          actionRequired: h.actionRequired ?? false,
          refundHash: h.refundHash ?? null,
        };
      } catch (e) {
        hd = { houdiniId, error: e.message };
      }
    }
    // Houdini says ICP was sent; nudge the router instead of waiting for its next tick.
    // At most one poke per order every pokeEveryMs, however many tabs are polling.
    const k = String(order.id);
    if (hd?.status === 4 && statusName(order.status) === 'awaitingDeposit' && !(Date.now() - (lastPoke.get(k) || 0) < pokeEveryMs)) {
      lastPoke.set(k, Date.now());
      if (lastPoke.size > 5_000) lastPoke.clear();
      await ic.poke(order.id).catch(() => {});
    }
    const fresh = (await ic.getOrder(BigInt(id))) ?? order;
    return [
      200,
      {
        orderId: fresh.id,
        stage: statusName(fresh.status),
        detail: Object.values(fresh.status)[0],
        houdini: hd,
        recipient: fresh.recipient.toText(),
        refundTo: fresh.refundTo.toText(),
        icpDepositAccount: fresh.depositAccountId,
      },
    ];
  }

  // Every few minutes: orders older than 20 min whose Houdini exchange expired, failed, was
  // refunded or deleted are cancelled on the router (only if nothing was deposited).
  async function cleanup() {
    let checked = 0;
    for (const [id, o] of openOrders) {
      if (Date.now() - o.at > 6 * 3600_000) { openOrders.delete(id); continue; }
      if (Date.now() - o.at < 20 * 60_000 || checked >= 30) continue;
      checked += 1;
      try {
        const r = await ic.getOrder(BigInt(id));
        if (!r || statusName(r.status) !== 'awaitingDeposit') { openOrders.delete(id); continue; }
        const h = await houdini.getOrder(o.houdiniId, o.user);
        if ([5, 6, 7, 8].includes(Number(h.status))) {
          if (await ic.cancelUnfunded(BigInt(id))) log('cancelled unfunded order', { id });
          openOrders.delete(id);
        } else if (Number(h.status) === 4) {
          openOrders.delete(id); // Houdini paid; the router takes it from here
        }
      } catch {
        // try again next round
      }
    }
  }
  if (cleanupEveryMs > 0) setInterval(() => cleanup().catch(() => {}), cleanupEveryMs).unref();

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    const user = userContext(req);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, SECURITY_HEADERS);
        return res.end();
      }
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { error: 'send JSON' });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const cfg = ic.config;
        const rh = ic.routerHealth;
        const icpUsd = prices.icpUsd ?? null;
        const maxOrderIcp = Number(cfg.maxOrderIcp) / 1e8;
        return json(res, 200, {
          acceptingOrders: Boolean(ic.routerId) && (rh ? rh.acceptingOrders : !cfg.paused),
          prices: { icpUsd, nakUsd: prices.nakUsd ?? null },
          guide: {
            minUsd: HOUDINI_MIN_USD,
            maxOrderIcp,
            maxUsd: icpUsd ? Math.floor(maxOrderIcp * icpUsd) : null,
            minOrderIcp: Number(cfg.minOrderIcp) / 1e8,
          },
          ok: true,
          houdini: houdini.mode,
          houdiniReady: houdini.ready !== false,
          router: ic.routerId,
          routerReady: Boolean(ic.routerId),
          routerError: ic.routerError ? 'router unreachable' : null,
          operator: ic.principal,
          limits: {
            minOrderIcp: Number(cfg.minOrderIcp) / 1e8,
            maxOrderIcp,
            maxImpactPct: Number(cfg.maxImpactBps) / 100,
            slippagePct: Number(cfg.slippageBps) / 100,
          },
          fee: { pct: Number(ic.feeBps ?? 100n) / 100, appliesTo: 'ICP received, completed swaps only' },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/tokens') {
        if (!allowTokens(user.ip)) return json(res, 429, { error: 'too many requests, slow down' });
        const term = (url.searchParams.get('term') || '').slice(0, 40);
        return json(res, 200, { tokens: await tokens(term, user) });
      }
      if (req.method === 'POST' && url.pathname === '/api/quote') {
        const [code, body] = await quote(await readBody(req), user);
        return json(res, code, body);
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        const [code, body] = await createOrder(await readBody(req), user);
        return json(res, code, body);
      }
      const m = url.pathname.match(/^\/api\/orders\/(\d+)$/);
      if (req.method === 'GET' && m) {
        const [code, body] = await getOrder(m[1], req.headers['x-order-key'], user);
        return json(res, code, body);
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(req, res, url.pathname)) return;
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      // Error text can echo addresses or principals back; mask anything that looks like one.
      log('error', String(e.message).replace(/[A-Za-z0-9-]{20,}/g, '…').slice(0, 200));
      const code = e.status && e.status < 500 ? e.status : e.status === 503 ? 503 : 502;
      // Messages written for users (ours, Houdini's) go through; raw internal errors don't.
      const msg = e.expose || code < 500 ? e.message : 'Something went wrong on our side. Nothing was sent; please try again.';
      return json(res, code, { error: msg });
    }
  };
}
