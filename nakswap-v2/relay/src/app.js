// HTTP API + swap page for NAKSwap v2. Pure request handling; houdini and ic clients are
// injected so the same code runs live, against mocks, and in tests.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encodeIcrcAccount } from './account.js';
import { ORDER_STATUS } from './houdini.js';

const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
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
// Behind Cloudflare with the origin lock on (see ORIGIN_SECRET), X-Real-IP is a Cloudflare
// address, so the visitor's IP comes from CF-Connecting-IP — trusted only on requests that
// carried the origin secret, i.e. that really came through Cloudflare.
function userContext(req, viaCloudflare = false) {
  const cf = viaCloudflare ? req.headers['cf-connecting-ip'] : undefined;
  const real = req.headers['x-real-ip'];
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = (typeof cf === 'string' && cf.trim()) || (typeof real === 'string' && real.trim()) || fwd[fwd.length - 1] || req.socket?.remoteAddress || '0.0.0.0';
  const tz = String(req.headers['x-user-timezone'] || 'UTC');
  return {
    // Rate limits are per visitor: one IPv4 address, or one IPv6 /64 (what one household or
    // phone usually gets). The visitor's own address goes to Houdini as is.
    ip: limitKey(ip),
    // Outer key for IPv6: the /48 (a free tunnel gives one person a whole /48 of /64s).
    net: limitKey(ip, 48),
    rawIp: String(ip).slice(0, 64),
    agent: String(req.headers['user-agent'] || 'unknown').slice(0, 256),
    timezone: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : 'UTC',
  };
}

// IPv6 -> its /64 prefix in full form (so "2a01:4f8::1" and "2a01:4f8:0:0::2" match);
// IPv4 and IPv4-mapped IPv6 -> the IPv4 address.
export function limitKey(ip, bits = 64) {
  let a = String(ip || '').trim().toLowerCase().split('%')[0];
  const mapped = a.match(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a.slice(0, 64);
  const [head, tail = null] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (a.includes('::') && h.length + t.length < 8) h.push(...new Array(8 - h.length - t.length).fill('0'));
  const n = bits === 48 ? 3 : 4;
  const groups = [...h, ...t].slice(0, n).map((g) => (g || '0').replace(/^0+(?=.)/, ''));
  while (groups.length < n) groups.push('0');
  return `${groups.join(':')}::/${bits === 48 ? 48 : 64}`;
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
// Paying with ICP directly has no Houdini leg (the amount is exact and the swap starts within
// a minute), so its guaranteed minimum can sit closer to the quote.
const MIN_OUT_TOLERANCE_DIRECT_BPS = 300n;
// Quotes are refused a little below the router's own price-impact refund line, so price
// drift between the quote and the swap doesn't turn an accepted order into a refund.
const IMPACT_MARGIN_BPS = 150n;
// Router orders paid directly in ICP (no Houdini leg) carry this in place of a Houdini id.
export const DIRECT_ICP = 'icp-direct';
// How long a direct-ICP order waits for its payment before the relay cancels it (freeing its
// open-order slot). A payment that still arrives later is picked up by the router's
// late-deposit watch and swapped or refunded.
export const DIRECT_WINDOW_MS = 45 * 60_000;
const MAX_ISSUED = 20_000;
// Keep the newest quotes when the registry is full (instead of wiping everyone's).
function trimIssued(issued) {
  for (const [k, v] of issued) if (Date.now() - v.at > QUOTE_TTL_MS) issued.delete(k);
  if (issued.size <= MAX_ISSUED) return;
  let drop = issued.size - MAX_ISSUED;
  for (const k of issued.keys()) {
    if (drop-- <= 0) break;
    issued.delete(k);
  }
}
const ICP_AMOUNT_RE = /^\d{1,6}(\.\d{1,8})?$/;
const toE8s = (s) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w) * 100_000_000n + BigInt((f + '00000000').slice(0, 8));
};
const icpText = (e8s) => {
  const v = BigInt(e8s);
  const f = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / 100_000_000n}${f ? `.${f}` : ''}`;
};

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
  const rel = pathname === '/' ? 'index.html' : pathname === '/admin' || pathname === '/admin/' ? 'admin/index.html' : pathname === '/terms' ? 'terms.html' : pathname.replace(/^\/+/, '');
  const isAdminPage = rel === 'admin/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, {
    ...(isAdminPage ? ADMIN_HEADERS : SECURITY_HEADERS),
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    // Pages and the dashboard bundle: always revalidated. Fonts never change: a year.
    // Images and icons: a day.
    'Cache-Control': isAdminPage
      ? 'no-store'
      : rel === 'index.html' || rel === 'terms.html' || rel.startsWith('admin/')
        ? 'no-cache'
        : rel.startsWith('fonts/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=86400',
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
  houdiniCacheMs = 15_000,
  quoteCacheMs = 20_000,
  // Site-wide orders per hour. 150 keeps well inside the router's 150 open-order cap (orders
  // stay open ~5-45 min while Houdini works) and its ~120-180 swaps/hour throughput.
  orderLimitPerHour = 150,
  cleanupEveryMs = 5 * 60_000,
  // Optional stricter quote-time price-impact limit (bps); never above the router's.
  maxQuoteImpactBps = null,
  directWindowMs = DIRECT_WINDOW_MS,
  // Once the site has its own domain: every other host name (e.g. the railway.app one) is
  // sent there, so there is one site and one admin origin. /api/health stays for Railway.
  canonicalHost = null,
  // Optional origin lock: when set, every request except /api/health must carry this value in
  // the x-origin-secret header (added by a Cloudflare request-header rule), so the Railway
  // address can't be hit directly to get around Cloudflare's protection.
  originSecret = null,
  // Requests that call out to Houdini or the IC, at once: site-wide and per visitor. Past
  // that, new ones get a quick "busy" instead of piling up behind slow upstream calls.
  maxInFlight = 64,
  maxInFlightPerIp = 6,
}) {
  const originDigest = originSecret ? crypto.createHash('sha256').update(String(originSecret)).digest() : null;
  const fromCloudflare = (req) => {
    const v = req.headers['x-origin-secret'];
    if (!originDigest || typeof v !== 'string') return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(v).digest(), originDigest);
  };
  let inFlight = 0;
  const inFlightByIp = new Map();
  // Runs a handler that calls out (Houdini / IC) under the concurrency caps.
  async function upstream(res, user, fn) {
    const mine = inFlightByIp.get(user.ip) || 0;
    if (mine >= maxInFlightPerIp) return json(res, 429, { error: 'too many requests at once, slow down' });
    if (inFlight >= maxInFlight) return json(res, 503, { error: 'NAKSwap is very busy right now. Please try again in a moment.' });
    inFlight += 1;
    inFlightByIp.set(user.ip, mine + 1);
    try {
      const [code, body] = await fn();
      return json(res, code, body);
    } finally {
      inFlight -= 1;
      const left = (inFlightByIp.get(user.ip) || 1) - 1;
      if (left > 0) inFlightByIp.set(user.ip, left);
      else inFlightByIp.delete(user.ip);
    }
  }
  // The price-impact line quotes must stay under: the router's refund line minus a margin,
  // or the configured limit if that is lower.
  const quoteImpactCap = () => {
    const routerMax = BigInt(ic.config.maxImpactBps);
    let cap = routerMax > IMPACT_MARGIN_BPS + 100n ? routerMax - IMPACT_MARGIN_BPS : routerMax;
    if (maxQuoteImpactBps != null && BigInt(maxQuoteImpactBps) < cap) cap = BigInt(maxQuoteImpactBps);
    return cap;
  };
  // "Try about N or less": the largest ICP amount under the cap. It doesn't depend on the
  // amount asked, so one search serves everyone for 30 seconds.
  let adviceCache = { at: 0, cap: null, max: null };
  async function impactAdvice() {
    const cap = quoteImpactCap();
    if (adviceCache.cap === cap && Date.now() - adviceCache.at < 30_000) return adviceCache.max;
    try {
      const max = await ic.maxIcpForImpact(cap, BigInt(ic.config.maxOrderIcp) * 2n);
      adviceCache = { at: Date.now(), cap, max: max > 0n ? max : null };
    } catch {
      return null;
    }
    return adviceCache.max;
  }
  const depositCache = new Map(); // order id -> { at, bal }
  // Per visitor IP, plus global ceilings so many addresses together still can't flood the
  // router with orders or burn the Houdini quote allowance.
  const allowOrder = limiter(5, 10 * 60_000);
  const allowOrderGlobal = limiter(orderLimitPerHour, 60 * 60_000);
  const allowQuote = limiter(30, 60_000);
  // Site-wide ceiling on quotes that reach Houdini (cached answers don't count), plus a
  // per-visitor hourly cap, so a few addresses can't use up the Houdini quota for everyone.
  const allowQuoteGlobal = limiter(1_200, 60 * 60_000);
  const allowQuoteHourly = limiter(120, 60 * 60_000);
  // The same limits, 6x looser, per IPv6 /48 (for IPv4 the key is the address itself).
  const allowQuoteHourlyNet = limiter(720, 60 * 60_000);
  const allowOrderNet = limiter(30, 10 * 60_000);
  // Pay-with-ICP quotes never reach Houdini (two free pool queries); their own ceiling.
  const allowIcpQuoteGlobal = limiter(6_000, 60 * 60_000);
  // Pay-with-ICP orders cost nothing to open, so they get their own, smaller share of the
  // hourly order budget: unpaid ones can't fill the router's open-order slots.
  const allowDirectOrderGlobal = limiter(Math.max(1, Math.floor(orderLimitPerHour * 0.4)), 60 * 60_000);
  // Orders this relay opened that are still waiting for a deposit (lost on restart; the
  // router's own TTL is the backstop). Used to cap open orders per visitor and to cancel
  // orders whose Houdini exchange expired or failed.
  const openOrders = new Map(); // id -> { houdiniId, at, ip, user }
  const MAX_OPEN_PER_IP = 5;
  const allowView = limiter(120, 60_000);
  const allowTokens = limiter(60, 60_000);
  // Site-wide ceiling on token searches that reach Houdini (each costs Houdini quota).
  const allowTokensGlobal = limiter(1_200, 60 * 60_000);
  const allowTokenSearchHourly = limiter(150, 60 * 60_000);
  const termCache = new Map(); // search term -> { at, tokens }
  const quoteCache = new Map(); // ip|fromId|amount|refund -> { at, result }
  const issued = new Map(); // quoteId -> { at, blocked, nakOut }
  const houdiniCache = new Map(); // houdiniId -> { at, h }
  const lastPoke = new Map(); // order id -> ms
  let tokenCache = { at: 0, term: null, tokens: [] };

  async function tokens(term, user) {
    const key = (term || '').toLowerCase();
    // The default list (no search term) is shared by everyone and refreshed every 10 minutes;
    // it is never subject to the search limits, and a stale copy is served if Houdini fails.
    if (!key) {
      if (tokenCache.term === '' && Date.now() - tokenCache.at < 10 * 60_000) return tokenCache.tokens;
      try {
        const list = await fetchTokens('', user);
        tokenCache = { at: Date.now(), term: '', tokens: list };
        return list;
      } catch (e) {
        if (tokenCache.term === '' && tokenCache.tokens.length) return tokenCache.tokens;
        throw e;
      }
    }
    const hit = termCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.tokens;
    // Searches reach Houdini: per visitor per hour and site-wide. Over a limit, an older
    // result for the same term is still served.
    if (!allowTokenSearchHourly(user.ip) || !allowTokensGlobal('all')) {
      if (hit) return hit.tokens;
      throw Object.assign(new Error('Too many token searches right now. Pick from the list, or try again in a few minutes.'), { status: 429, expose: true });
    }
    const list = await fetchTokens(key, user);
    for (const [k, v] of termCache) if (Date.now() - v.at >= 10 * 60_000) termCache.delete(k);
    if (termCache.size < 2_000) termCache.set(key, { at: Date.now(), tokens: list });
    return list;
  }

  async function fetchTokens(key, user) {
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
    // Same token + amount within a few seconds (typing, re-renders): reuse the last answer
    // instead of spending another Houdini quote request.
    // Per visitor: quote ids are never handed to two different people.
    const qKey = `${user.ip}|${fromId}|${amount}|${refundAddress}`;
    const cached = quoteCache.get(qKey);
    if (cached && Date.now() - cached.at < quoteCacheMs) return [200, cached.result];
    for (const [k, v] of quoteCache) if (Date.now() - v.at >= quoteCacheMs) quoteCache.delete(k);
    if (!allowQuoteHourly(user.ip) || (user.net !== user.ip && !allowQuoteHourlyNet(user.net))) return [429, { error: 'Too many quotes from your connection this hour. Try again later.' }];
    if (!allowQuoteGlobal('all')) return [503, { error: 'NAKSwap is very busy right now. Please try again in a few minutes, or pay with ICP directly.' }];
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
    // Both routes' pool previews at once.
    const previews = await Promise.all(
      quotes.map((q) => {
        const e8s = BigInt(Math.floor(Number(q.amountOut) * 1e8));
        return e8s > 0n ? ic.previewSwap(e8s) : null;
      }),
    );
    for (const [i, q] of quotes.entries()) {
      const icpE8s = BigInt(Math.floor(Number(q.amountOut) * 1e8));
      if (icpE8s <= 0n) continue;
      const p = previews[i];
      let blocked = null;
      if (q.min && Number(amount) < Number(q.min)) blocked = `Houdini minimum for this route is ${q.min}`;
      else if (q.max && Number(amount) > Number(q.max)) blocked = `Houdini maximum for this route is ${q.max}`;
      else if (icpE8s < cfg.minOrderIcp) blocked = `below the router minimum of ${Number(cfg.minOrderIcp) / 1e8} ICP`;
      else if (icpE8s > cfg.maxOrderIcp) blocked = `above the router maximum of ${Number(cfg.maxOrderIcp) / 1e8} ICP`;
      let suggest = null;
      if (!blocked && p.impactBps > quoteImpactCap()) {
        const maxIcp = await impactAdvice();
        // Same token, scaled down to the ICP amount that fits (rounded down, 4 significant digits).
        if (maxIcp) suggest = Number((Number(amount) * Number(maxIcp) / Number(icpE8s)).toPrecision(4));
        blocked = `price impact ${Number(p.impactBps) / 100}% is above the ${Number(quoteImpactCap()) / 100}% limit${suggest ? `. Try about ${suggest} or less` : ''}`;
      }
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
        suggestAmount: suggest,
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
      router: { ready: Boolean(ic.routerId), slippageBps: cfg.slippageBps, maxImpactBps: cfg.maxImpactBps, quoteImpactCapBps: quoteImpactCap() },
    };
    quoteCache.set(qKey, { at: Date.now(), result });
    trimIssued(issued);
    for (const r of routes) issued.set(String(r.quoteId), { at: Date.now(), blocked: r.blocked, nakOut: BigInt(r.nakOut) });
    return [200, result];
  }

  // Paying with ICP directly: no Houdini leg, the visitor sends ICP to the order's deposit
  // account from any ICP wallet or exchange. Same router, fees and protections.
  async function quoteIcp(body, user) {
    const cfg = ic.config;
    const amount = str(body.amount);
    if (!amount || !ICP_AMOUNT_RE.test(amount) || !(Number(amount) > 0)) return [400, { error: 'Enter an ICP amount, e.g. 2.5 (up to 8 decimals)' }];
    if (!allowQuote(user.ip)) return [429, { error: 'too many quote requests, slow down' }];
    const icpE8s = toE8s(amount);
    const qKey = `${user.ip}|icp|${amount}`;
    const cached = quoteCache.get(qKey);
    if (cached && Date.now() - cached.at < quoteCacheMs) return [200, cached.result];
    for (const [k, v] of quoteCache) if (Date.now() - v.at >= quoteCacheMs) quoteCache.delete(k);
    if (!allowIcpQuoteGlobal('all')) return [503, { error: 'NAKSwap is very busy right now. Please try again in a few minutes.' }];
    let blocked = null;
    let suggestAmount = null;
    let p = { amountIn: 0n, nakswapFee: 0n, nakOut: 0n, impactBps: 0n };
    if (icpE8s < cfg.minOrderIcp) blocked = `the minimum is ${icpText(cfg.minOrderIcp)} ICP`;
    else if (icpE8s > cfg.maxOrderIcp) {
      blocked = `the maximum is ${icpText(cfg.maxOrderIcp)} ICP per swap`;
      suggestAmount = icpText(cfg.maxOrderIcp);
    } else {
      p = await ic.previewSwap(icpE8s);
      if (p.impactBps > quoteImpactCap()) {
        const maxIcp = await impactAdvice();
        suggestAmount = maxIcp ? icpText((maxIcp / 1_000_000n) * 1_000_000n) : null;
        blocked = `price impact ${Number(p.impactBps) / 100}% is above the ${Number(quoteImpactCap()) / 100}% limit${suggestAmount ? `. Try ${suggestAmount} ICP or less` : ''}`;
      }
    }
    const quoteId = `icp-${crypto.randomBytes(12).toString('hex')}`;
    const result = {
      quoteId,
      route: 'icp',
      icpIn: icpE8s,
      nakswapFeeIcp: p.nakswapFee,
      nakOut: p.nakOut,
      guaranteedNak: (p.nakOut * (10_000n - MIN_OUT_TOLERANCE_DIRECT_BPS)) / 10_000n,
      impactBps: p.impactBps,
      blocked,
      suggestAmount,
      windowMinutes: directWindowMs / 60_000,
      quotedAt: Date.now(),
    };
    quoteCache.set(qKey, { at: Date.now(), result });
    trimIssued(issued);
    issued.set(quoteId, { at: Date.now(), kind: 'icp', blocked, nakOut: p.nakOut, icpE8s });
    return [200, result];
  }

  async function createDirectOrder(q, recipientP, refundToP, user) {
    const minNakOut = (q.nakOut * (10_000n - MIN_OUT_TOLERANCE_DIRECT_BPS)) / 10_000n;
    const order = await ic.createOrder({ recipient: recipientP, refundTo: refundToP, minNakOut: minNakOut > 0n ? minNakOut : null });
    // Marks the order as paid directly (so the router keeps it for the full window instead of
    // dropping it as unpaired after 15 minutes). Without it, don't show where to pay.
    if ((await ic.attachHoudini(order.id, DIRECT_ICP)) !== true) {
      throw Object.assign(new Error('Could not set up the order. Nothing was sent; please try again.'), { status: 502, expose: true });
    }
    log('order', { id: order.id.toString(), route: 'icp' });
    openOrders.set(order.id.toString(), { direct: true, at: Date.now(), ip: user.ip, user });
    return [
      201,
      {
        orderId: order.id,
        orderKey: orderKey(secret, order.id),
        route: 'icp',
        send: {
          amount: icpText(q.icpE8s),
          symbol: 'ICP',
          chain: 'icp',
          to: order.depositAccountId,
          icrc: ic.routerId ? encodeIcrcAccount(ic.routerId, order.depositSubaccount) : null,
          tag: null,
          expires: new Date(Date.now() + directWindowMs).toISOString(),
        },
        guaranteedNak: minNakOut,
        icpDepositAccount: order.depositAccountId,
        nakRecipient: recipientP.toText(),
      },
    ];
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
    if (!allowOrder(user.ip) || (user.net !== user.ip && !allowOrderNet(user.net))) return [429, { error: 'Too many orders from your connection. Wait a few minutes and try again.' }];
    if ([...openOrders.values()].filter((o) => o.ip === user.ip).length >= MAX_OPEN_PER_IP) {
      return [429, { error: 'You already have several swaps waiting for a deposit. Finish or let them expire first.' }];
    }
    const q = issued.get(quoteId);
    if (!q || Date.now() - q.at > QUOTE_TTL_MS) return [409, { error: 'That quote has expired. Get a fresh quote and try again.' }];
    if (q.blocked) return [400, { error: `That route can't be used: ${q.blocked}.` }];
    if (q.kind === 'icp' && !allowDirectOrderGlobal('all')) return [503, { error: 'Many pay-with-ICP swaps are waiting for payment right now. Please try again in a little while.' }];
    if (!allowOrderGlobal('all')) return [503, { error: 'NAKSwap is very busy right now. Please try again in a little while.' }];
    issued.delete(quoteId); // one order per quote
    // ...and never hand the same quote out again from the short-lived quote cache.
    for (const [k, v] of quoteCache) {
      if (v.result.quoteId === quoteId || v.result.routes?.some((r) => String(r.quoteId) === quoteId)) quoteCache.delete(k);
    }
    if (q.kind === 'icp') return createDirectOrder(q, recipientP, refundToP, user);
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

  // At most one router poke per order every pokeEveryMs, however many tabs are polling. Not
  // awaited by the page's request: a poke can run a whole swap; the next poll shows it.
  function nudge(orderId) {
    const k = String(orderId);
    if (Date.now() - (lastPoke.get(k) || 0) < pokeEveryMs) return;
    lastPoke.set(k, Date.now());
    if (lastPoke.size > 5_000) lastPoke.clear();
    ic.poke(orderId).catch(() => {});
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
    const direct = houdiniId === DIRECT_ICP;
    if (direct) {
      const stage = statusName(order.status);
      let received = null;
      if (stage === 'awaitingDeposit' || stage === 'expired') {
        const k = String(order.id);
        const c = depositCache.get(k);
        if (c && Date.now() - c.at < houdiniCacheMs) received = c.bal;
        else {
          received = await ic.depositBalance(order.depositSubaccount).catch(() => null);
          depositCache.set(k, { at: Date.now(), bal: received });
          if (depositCache.size > 5_000) depositCache.clear();
        }
      }
      // ICP has landed, or NAK / a refund is ready to go: nudge the router instead of waiting
      // for its next pass.
      if ((stage === 'awaitingDeposit' && received > 0n) || stage === 'payoutPending' || stage === 'refundPending') nudge(order.id);
      const fresh = order;
      return [
        200,
        {
          orderId: fresh.id,
          route: 'icp',
          stage: statusName(fresh.status),
          detail: Object.values(fresh.status)[0],
          houdini: null,
          receivedIcp: received,
          deposit: {
            to: fresh.depositAccountId,
            icrc: ic.routerId ? encodeIcrcAccount(ic.routerId, fresh.depositSubaccount) : null,
            expires: new Date(Number(BigInt(fresh.createdAt) / 1_000_000n) + directWindowMs).toISOString(),
          },
          recipient: fresh.recipient.toText(),
          refundTo: fresh.refundTo.toText(),
          icpDepositAccount: fresh.depositAccountId,
        },
      ];
    }
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
    const st = statusName(order.status);
    if ((hd?.status === 4 && st === 'awaitingDeposit') || st === 'payoutPending' || st === 'refundPending') nudge(order.id);
    const fresh = order;
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

  // Public totals for the stats strip, refreshed at most once a minute.
  let statsCache = { at: 0, v: null };
  async function stats() {
    if (statsCache.v && Date.now() - statsCache.at < 60_000) return statsCache.v;
    try {
      const s = await ic.publicStats();
      statsCache = { at: Date.now(), v: { swaps: Number(s.swaps), icpSwapped: Number(s.icpSwapped) / 1e8, nakDelivered: Number(s.nakDelivered) / 1e8 } };
    } catch {
      if (!statsCache.v) return { swaps: null, icpSwapped: null, nakDelivered: null };
    }
    return statsCache.v;
  }

  // Every few minutes: orders older than 20 min whose Houdini exchange expired, failed, was
  // refunded or deleted are cancelled on the router (only if nothing was deposited).
  async function cleanup() {
    let checked = 0;
    for (const [id, o] of openOrders) {
      if (Date.now() - o.at > 6 * 3600_000) { openOrders.delete(id); continue; }
      if (o.direct) {
        // Direct ICP: past its window and still unpaid -> cancel, freeing the slot. (If ICP
        // is there, the router refuses and swaps it as usual.)
        if (Date.now() - o.at < directWindowMs || checked >= 30) continue;
        checked += 1;
        try {
          if (await ic.cancelUnfunded(BigInt(id))) log('cancelled unpaid direct order', { id });
          openOrders.delete(id);
        } catch {
          // try again next round
        }
        continue;
      }
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

  // After a restart or deploy: pick up the router's unpaid pay-with-ICP orders again, so
  // they are still cancelled when their window ends (they would otherwise hold open-order
  // slots for the router's full order window).
  async function restoreOpenOrders() {
    if (typeof ic.activeOrderIds !== 'function' || !ic.routerId) return;
    const ids = await ic.activeOrderIds();
    for (const id of ids.slice(0, 500)) {
      const k = String(id);
      if (openOrders.has(k)) continue;
      const o = await ic.getOrder(BigInt(id)).catch(() => null);
      if (!o || o.houdiniId[0] !== DIRECT_ICP || statusName(o.status) !== 'awaitingDeposit') continue;
      openOrders.set(k, { direct: true, at: Number(BigInt(o.createdAt) / 1_000_000n), ip: null, user: null });
    }
  }
  if (cleanupEveryMs > 0) {
    let tries = 0;
    const restore = () =>
      restoreOpenOrders().catch((e) => {
        log('restore open orders failed', String(e?.message || e).slice(0, 120));
        if (++tries < 5) setTimeout(restore, 60_000).unref();
      });
    restore();
  }

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    // Origin lock: only Cloudflare (which adds the secret) gets past this. Health stays open
    // for Railway's own checks.
    const viaCloudflare = fromCloudflare(req);
    if (originDigest && !viaCloudflare && url.pathname !== '/api/health') {
      // Old links to the hosting address: pages go to the site's own domain (nothing is
      // served from here); everything else is refused.
      if (canonicalHost && (req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && req.url.length <= 2_048) {
        res.writeHead(301, { ...SECURITY_HEADERS, Location: `https://${canonicalHost}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('forbidden');
    }
    // Only what the site uses: GET and POST (HEAD for pages). No OPTIONS: the API is same-origin
    // only and has no CORS.
    const isApi = url.pathname.startsWith('/api/');
    const methodOk = req.method === 'GET' || req.method === 'POST' || (req.method === 'HEAD' && (!isApi || url.pathname === '/api/health'));
    if (!methodOk) {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, POST', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end('{"error":"method not allowed"}');
    }
    if (req.url.length > 2_048) return json(res, 414, { error: 'URL too long' });
    if (req.method === 'POST' && Number(req.headers['content-length']) > 8_192) {
      // Refused unread, so the connection is closed rather than left holding the body.
      res.writeHead(413, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
      return res.end('{"error":"body too large"}');
    }
    const user = userContext(req, viaCloudflare);
    const host = String(req.headers.host || '').toLowerCase();
    if (canonicalHost && host && host !== canonicalHost && url.pathname !== '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(301, { ...SECURITY_HEADERS, Location: `https://${canonicalHost}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    try {
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { error: 'send JSON' });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/health') {
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
          // The deployed commit (Railway sets it), so the monitor can compare the live pages
          // with that commit's files.
          commit: /^[0-9a-f]{7,40}$/.test(String(process.env.RAILWAY_GIT_COMMIT_SHA || '')) ? process.env.RAILWAY_GIT_COMMIT_SHA : null,
          limits: {
            minOrderIcp: Number(cfg.minOrderIcp) / 1e8,
            maxOrderIcp,
            maxImpactPct: Number(cfg.maxImpactBps) / 100,
            quoteImpactPct: Number(quoteImpactCap()) / 100,
            slippagePct: Number(cfg.slippageBps) / 100,
            orderWindowMinutes: Number(cfg.orderTtlSeconds) / 60,
            directWindowMinutes: directWindowMs / 60_000,
          },
          routes: { houdini: houdini.ready !== false, icp: Boolean(ic.routerId) },
          fee: { pct: Number(ic.feeBps ?? 100n) / 100, appliesTo: 'ICP received, completed swaps only' },
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/tokens') {
        if (!allowTokens(user.ip)) return json(res, 429, { error: 'too many requests, slow down' });
        const term = (url.searchParams.get('term') || '').slice(0, 40);
        return await upstream(res, user, async () => [200, { tokens: await tokens(term, user) }]);
      }
      if (req.method === 'POST' && url.pathname === '/api/quote') {
        const body = await readBody(req);
        return await upstream(res, user, () => quote(body, user));
      }
      if (req.method === 'POST' && url.pathname === '/api/quote-icp') {
        const body = await readBody(req);
        return await upstream(res, user, () => quoteIcp(body, user));
      }
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        if (!allowView(user.ip)) return json(res, 429, { error: 'too many requests, slow down' });
        return await upstream(res, user, async () => [200, await stats()]);
      }
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        const body = await readBody(req);
        return await upstream(res, user, () => createOrder(body, user));
      }
      const m = url.pathname.match(/^\/api\/orders\/(\d+)$/);
      if (req.method === 'GET' && m) {
        return await upstream(res, user, () => getOrder(m[1], req.headers['x-order-key'], user));
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && serveStatic(req, res, url.pathname)) return;
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
