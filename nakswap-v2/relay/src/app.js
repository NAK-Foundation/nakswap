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
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' https: data:",
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
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
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
  return {
    ip: ip.slice(0, 64),
    agent: String(req.headers['user-agent'] || 'unknown').slice(0, 256),
    timezone: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : 'UTC',
  };
}

// Input shapes accepted from the page; anything else is rejected before it reaches Houdini
// or the router.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ADDR_RE = /^[A-Za-z0-9:._-]{1,128}$/;

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
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
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
}) {
  // Per visitor IP, plus global ceilings so many addresses together still can't flood the
  // router with orders or burn the Houdini quote allowance.
  const allowOrder = limiter(5, 10 * 60_000);
  const allowOrderGlobal = limiter(60, 60 * 60_000);
  const allowQuote = limiter(30, 60_000);
  const allowView = limiter(120, 60_000);
  const allowTokens = limiter(60, 60_000);
  const quoteCache = new Map(); // fromId|amount|refund -> { at, result }
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
    const { fromId, amount, refundAddress } = body;
    if (!fromId || !(Number(amount) > 0)) return [400, { error: 'fromId and a positive amount are required' }];
    if (!ID_RE.test(String(fromId)) || !(Number(amount) < 1e15) || String(amount).length > 40) return [400, { error: 'invalid token or amount' }];
    if (refundAddress && !ADDR_RE.test(String(refundAddress))) return [400, { error: 'invalid refund address' }];
    if (!allowQuote(user.ip)) return [429, { error: 'too many quote requests, slow down' }];
    // Same token + amount within a few seconds (typing, re-renders): reuse the last answer
    // instead of spending another Houdini quote request.
    const qKey = `${fromId}|${Number(amount)}|${refundAddress || ''}`;
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
      quotedAt: Date.now(),
      router: { ready: Boolean(ic.routerId), slippageBps: cfg.slippageBps, maxImpactBps: cfg.maxImpactBps },
    };
    quoteCache.set(qKey, { at: Date.now(), result });
    return [200, result];
  }

  async function createOrder(body, user) {
    const { quoteId, recipient, refundAddress, refundTo, minNakOut } = body;
    if (!quoteId) return [400, { error: 'quoteId is required' }];
    if (!ID_RE.test(String(quoteId))) return [400, { error: 'invalid quoteId' }];
    if (refundAddress && !ADDR_RE.test(String(refundAddress))) return [400, { error: 'invalid refund address' }];
    if (minNakOut != null && !/^\d{1,30}$/.test(String(minNakOut))) return [400, { error: 'invalid minNakOut' }];
    let recipientP, refundToP;
    try {
      recipientP = ic.parsePrincipal(recipient);
      refundToP = refundTo ? ic.parsePrincipal(refundTo) : null;
    } catch (e) {
      return [400, { error: `invalid principal: ${e.message}` }];
    }
    if (!allowOrder(user.ip)) return [429, { error: 'Too many orders from your connection. Wait a few minutes and try again.' }];
    if (!allowOrderGlobal('all')) return [503, { error: 'NAKSwap is very busy right now. Please try again in a little while.' }];

    // 1. Router order first: it mints the deposit account Houdini will pay into.
    const order = await ic.createOrder({
      recipient: recipientP,
      refundTo: refundToP,
      minNakOut: minNakOut ? BigInt(minNakOut) : null,
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
      throw Object.assign(new Error(`Houdini did not accept the order: ${e.message}`), { status: e.status === 422 ? 422 : 502 });
    }
    // 3. Link them so support can trace either side.
    await ic.attachHoudini(order.id, ex.houdiniId);
    // Privacy: logs keep only the order number; no principals, addresses, amounts or IPs.
    log('order', { id: order.id.toString() });
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
        icpDepositAccount: order.depositAccountId,
        nakRecipient: recipientP.toText(),
        rerouted: ex.rerouted ?? false,
      },
    ];
  }

  async function getOrder(id, key, user) {
    if (!allowView(user.ip)) return [429, { error: 'too many requests, slow down' }];
    if (id.length > 20 || !crypto.timingSafeEqual(Buffer.from(String(key || '').padEnd(20).slice(0, 20)), Buffer.from(orderKey(secret, id)))) {
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

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://relay');
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
          routerError: ic.routerError,
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
      return json(res, e.status && e.status < 500 ? e.status : e.status === 503 ? 503 : 502, { error: e.message });
    }
  };
}
