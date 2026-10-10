// HTTP API + swap page for NAKSwap v2. Pure request handling; houdini and ic clients are
// injected so the same code runs live, against mocks, and in tests.
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
};

const json = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
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
      if (data.length > 16_384) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });

function userContext(req) {
  const fwd = req.headers['x-forwarded-for'];
  return {
    ip: (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.socket?.remoteAddress || '0.0.0.0',
    agent: req.headers['user-agent'] || 'unknown',
    timezone: req.headers['x-user-timezone'] || 'UTC',
  };
}

// Small fixed-window limiter (each order costs a canister call and a Houdini exchange).
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
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
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// Houdini's floor for standard and private routes, in USD (it rejects quotes below this).
export const HOUDINI_MIN_USD = 25;

export function createApp({ houdini, ic, prices = {}, log = () => {} }) {
  const allowOrder = limiter(10, 60_000);
  const allowQuote = limiter(60, 60_000);
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
    if (!allowQuote(user.ip)) return [429, { error: 'too many quote requests, slow down' }];
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
    return [
      200,
      {
        routes,
        quotedAt: Date.now(),
        router: { ready: Boolean(ic.routerId), slippageBps: cfg.slippageBps, maxImpactBps: cfg.maxImpactBps },
      },
    ];
  }

  async function createOrder(body, user) {
    const { quoteId, recipient, refundAddress, refundTo, minNakOut } = body;
    if (!quoteId) return [400, { error: 'quoteId is required' }];
    let recipientP, refundToP;
    try {
      recipientP = ic.parsePrincipal(recipient);
      refundToP = refundTo ? ic.parsePrincipal(refundTo) : null;
    } catch (e) {
      return [400, { error: `invalid principal: ${e.message}` }];
    }
    if (!allowOrder(user.ip)) return [429, { error: 'too many orders, slow down' }];

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
      log('houdini createExchange failed', { order: order.id.toString(), err: e.message });
      throw Object.assign(new Error(`Houdini did not accept the order: ${e.message}`), { status: e.status === 422 ? 422 : 502 });
    }
    // 3. Link them so support can trace either side.
    await ic.attachHoudini(order.id, ex.houdiniId);
    log('order', { id: order.id.toString(), houdini: ex.houdiniId, in: `${ex.inAmount} ${ex.inSymbol}` });
    return [
      201,
      {
        orderId: order.id,
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

  async function getOrder(id, user) {
    const order = await ic.getOrder(BigInt(id));
    if (!order) return [404, { error: 'order not found' }];
    let hd = null;
    const houdiniId = order.houdiniId[0];
    if (houdiniId) {
      try {
        const h = await houdini.getOrder(houdiniId, user);
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
    if (hd?.status === 4 && statusName(order.status) === 'awaitingDeposit') {
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
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST',
          'Access-Control-Allow-Headers': 'Content-Type,x-user-timezone',
        });
        return res.end();
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
        return json(res, 200, { tokens: await tokens(url.searchParams.get('term') || '', user) });
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
        const [code, body] = await getOrder(m[1], user);
        return json(res, code, body);
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(req, res, url.pathname)) return;
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      log('error', e.message);
      return json(res, e.status && e.status < 500 ? e.status : e.status === 503 ? 503 : 502, { error: e.message });
    }
  };
}
