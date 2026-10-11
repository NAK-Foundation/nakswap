import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { Principal } from '@icp-sdk/core/principal';
import { crc32, encodeIcrcAccount } from '../src/account.js';
import { createApp } from '../src/app.js';
import { createHoudini } from '../src/houdini.js';
import { createMockHoudini } from '../src/mockHoudini.js';

// In-memory router stand-in with the same surface as src/ic.js.
function fakeIc() {
  const orders = new Map();
  let next = 0n;
  const config = {
    icpFee: 10_000n,
    nakFee: 10_000n,
    minOrderIcp: 10_000_000n,
    maxOrderIcp: 5_000_000_000n,
    maxImpactBps: 500n,
    slippageBps: 100n,
    icpIsToken0: false,
    orderTtlSeconds: 7_200n,
  };
  return {
    principal: 'relay-test',
    routerId: 'bkyfl-uyaaa-aaaab-qhl5q-cai',
    config,
    orders,
    stats: { swaps: 3n, icpSwapped: 250_000_000n, nakDelivered: 2_000_000_000_000n, lateWatched: 0n },
    statsCalls: 0,
    async publicStats() {
      this.statsCalls += 1;
      return this.stats;
    },
    async maxIcpForImpact(limitBps, hi) {
      let lo = 0n;
      while (hi - lo > 1_000_000n) {
        const mid = (lo + hi) / 2n;
        if ((await this.previewSwap(mid)).impactBps <= limitBps) lo = mid;
        else hi = mid;
      }
      return lo;
    },
    async depositBalance(sub) {
      const o = [...orders.values()].find((x) => Buffer.from(x.depositSubaccount).equals(Buffer.from(sub)));
      return o ? o.paid : 0n;
    },
    parsePrincipal(t) {
      const p = Principal.fromText(String(t || '').trim());
      if (p.isAnonymous()) throw new Error('anonymous principal');
      return p;
    },
    async previewSwap(icp) {
      const amountIn = icp - 30_000n;
      // ~110k NAK per ICP, impact grows 1 bps per 0.1 ICP
      return { amountIn, nakOut: amountIn * 110_000n, impactBps: amountIn / 10_000_000n };
    },
    async createOrder({ recipient, refundTo, minNakOut }) {
      const id = next++;
      const o = {
        id,
        recipient,
        refundTo: refundTo ?? recipient,
        minNakOut: minNakOut ?? 0n,
        depositAccountId: id.toString(16).padStart(64, 'a'),
        depositSubaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? Number(id) + 1 : 0)),
        createdAt: BigInt(Date.now()) * 1_000_000n,
        houdiniId: [],
        status: { awaitingDeposit: null },
        paid: 0n,
      };
      orders.set(id, o);
      return o;
    },
    cancelled: [],
    async cancelUnfunded(id) {
      const o = orders.get(id);
      if (!o || o.paid > 0n || !('awaitingDeposit' in o.status)) return false;
      o.status = { expired: null };
      this.cancelled.push(id);
      return true;
    },
    async attachHoudini(id, h) {
      orders.get(id).houdiniId = [h];
      return true;
    },
    async getOrder(id) {
      return orders.get(id) ?? null;
    },
    async poke(id) {
      const o = orders.get(id);
      if (o.paid > 0n) o.status = { completed: { icpIn: o.paid, nakOut: o.paid * 110_000n, block: 1n } };
      return { processed: o.status };
    },
  };
}

async function serve(handle) {
  const server = http.createServer(handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.7', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { code: res.status, body: await res.json(), headers: res.headers };
  };
  return { call, close: () => server.close() };
}

const ALICE = 'xevnm-gaaaa-aaaar-qafnq-cai';

test('mock flow: quote -> order -> Houdini pays the deposit account -> NAK delivered', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({
    settleAfterMs: 50,
    payIcp: async (accountHex, e8s) => {
      const o = [...ic.orders.values()].find((x) => x.depositAccountId === accountHex);
      o.paid = e8s;
    },
  });
  const { call, close } = await serve(createApp({ houdini, ic, pokeEveryMs: 0, houdiniCacheMs: 0 }));
  try {
    const q = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '100' });
    assert.equal(q.code, 200);
    assert.equal(q.body.routes.length, 2);
    const best = q.body.routes[0];
    assert.equal(best.type, 'standard', 'standard has the smaller haircut, so it ranks first');
    assert.equal(best.blocked, null);

    const o = await call('POST', '/api/orders', { quoteId: best.quoteId, recipient: ALICE, refundAddress: 'TXYZ' });
    assert.equal(o.code, 201);
    assert.equal(o.body.icpDepositAccount.length, 64);
    assert.equal(o.body.nakRecipient, ALICE);
    assert.equal(o.body.send.symbol, 'USDT');
    assert.equal(ic.orders.get(0n).houdiniId[0], o.body.houdiniId, 'router order is linked to the Houdini order');

    await new Promise((r) => setTimeout(r, 80));
    const view = `/api/orders/${o.body.orderId}`;
    const key = { 'x-order-key': o.body.orderKey };
    assert.equal((await call('GET', view)).code, 404, 'no key, no order');
    assert.equal((await call('GET', view, undefined, { 'x-order-key': '00000000000000000000' })).code, 404, 'wrong key, no order');
    assert.equal((await call('GET', `${view}?key=${o.body.orderKey}`)).code, 404, 'key in the URL is not accepted');
    await call('GET', view, undefined, key); // triggers mock payout
    await new Promise((r) => setTimeout(r, 20));
    const s = await call('GET', view, undefined, key);
    assert.equal(s.body.houdini.statusLabel, 'COMPLETED');
    assert.equal(s.body.stage, 'completed', 'relay pokes the router once Houdini reports COMPLETED');
  } finally {
    close();
  }
});

test('quote flags routes the router would refund', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic }));
  try {
    const tiny = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '0.1' });
    assert.match(tiny.body.routes[0].blocked, /below the router minimum/);
    const big = await call('POST', '/api/quote', { fromId: 'mock-eth', amount: '10' });
    assert.match(big.body.routes[0].blocked, /above the router maximum/);
  } finally {
    close();
  }
});

test('order validation: bad and anonymous principals are rejected before any side effect', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic }));
  try {
    const q = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '100' });
    const bad = await call('POST', '/api/orders', { quoteId: q.body.routes[0].quoteId, recipient: 'not-a-principal' });
    assert.equal(bad.code, 400);
    const anon = await call('POST', '/api/orders', { quoteId: q.body.routes[0].quoteId, recipient: '2vxsx-fae' });
    assert.equal(anon.code, 400);
    assert.equal(ic.orders.size, 0);
  } finally {
    close();
  }
});

test('live Houdini client sends auth + compliance headers and the deposit account as addressTo', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    let body = {};
    if (u.pathname.endsWith('/tokens')) body = { tokens: [{ id: 'icp-id', symbol: 'ICP', chain: 'icp' }] };
    if (u.pathname.endsWith('/quotes')) body = { quotes: [{ quoteId: 'q1', type: 'standard', amountOut: 12.5 }] };
    if (u.pathname.endsWith('/exchanges')) body = { houdiniId: 'h1', depositAddress: '0xabc', inAmount: 1, inSymbol: 'ETH' };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const h = createHoudini({ apiKey: 'k', apiSecret: 's', fetchImpl });
  const user = { ip: '203.0.113.7', agent: 'UA', timezone: 'America/Chicago' };
  const quotes = await h.quotesToIcp({ fromId: 'eth-id', amount: '1', user });
  assert.equal(quotes[0].quoteId, 'q1');
  await h.createExchange({ quoteId: 'q1', addressTo: 'ab'.repeat(32), refundAddress: '0xme', user });

  const tokenCall = new URL(calls[0].url);
  assert.equal(tokenCall.searchParams.get('chain'), 'icp');
  assert.equal(tokenCall.searchParams.get('symbol'), 'ICP');
  const quoteCall = new URL(calls[1].url);
  assert.equal(quoteCall.pathname, '/v2/quotes');
  assert.equal(quoteCall.searchParams.get('to'), 'icp-id');
  assert.deepEqual(quoteCall.searchParams.getAll('types'), ['standard', 'private']);
  const ex = calls[2];
  assert.equal(ex.init.method, 'POST');
  assert.deepEqual(JSON.parse(ex.init.body), { quoteId: 'q1', addressTo: 'ab'.repeat(32), refundAddress: '0xme' });
  for (const c of calls) {
    assert.equal(c.init.headers.Authorization, 'k:s');
    assert.equal(c.init.headers['x-user-ip'], '203.0.113.7');
    assert.equal(c.init.headers['x-user-timezone'], 'America/Chicago');
  }
});

test('hardening: security headers, no CORS, spoofed X-Forwarded-For does not dodge order limits', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic }));
  try {
    const h = await call('GET', '/api/health');
    assert.equal(h.headers.get('access-control-allow-origin'), null);
    assert.equal(h.headers.get('x-frame-options'), 'DENY');
    assert.match(h.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const q = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '100' });
    let last;
    for (let i = 0; i < 7; i++) {
      // a new fake X-Forwarded-For each time; the edge-set X-Real-IP stays the same
      last = await call('POST', '/api/orders', { quoteId: q.body.routes[0].quoteId, recipient: ALICE }, { 'x-forwarded-for': `10.0.0.${i}` });
    }
    assert.equal(last.code, 429);
    assert.equal(ic.orders.size, 1, 'a quote can be used for one order only');
    const junk = await call('POST', '/api/quote', { fromId: '../../etc', amount: '100' });
    assert.equal(junk.code, 400);
  } finally {
    close();
  }
});

test('audit fixes: malformed URLs, invented quotes, bad keys, relay-set minimum', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const handle = createApp({ houdini, ic });
  const { call, close } = await serve(handle);
  try {
    // A request line that used to throw outside the try and kill the process.
    const net = await import('node:net');
    const srv = http.createServer(handle);
    await new Promise((r) => srv.listen(0, r));
    const raw = await new Promise((resolve) => {
      const sock = net.connect(srv.address().port, '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nHost: x\r\n\r\n'));
      let buf = '';
      sock.on('data', (d) => { buf += d; sock.end(); });
      sock.on('close', () => resolve(buf));
    });
    srv.close();
    assert.match(raw, /^HTTP\/1\.1 (400|404)/, 'answered instead of crashing');

    const fake = await call('POST', '/api/orders', { quoteId: 'made-up', recipient: ALICE });
    assert.equal(fake.code, 409, 'quotes the relay never issued are refused');
    assert.equal(ic.orders.size, 0, 'and no router order is opened for them');

    const q = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '100' });
    const route = q.body.routes[0];
    const o = await call('POST', '/api/orders', { quoteId: route.quoteId, recipient: ALICE, minNakOut: '1' });
    assert.equal(o.code, 201);
    const stored = ic.orders.get(BigInt(o.body.orderId));
    assert.equal(stored.minNakOut, BigInt(route.guaranteedNak), 'the relay sets the minimum from its own quote, ignoring the client');
    assert.ok(BigInt(route.guaranteedNak) < BigInt(route.nakOut));

    const again = await call('POST', '/api/orders', { quoteId: route.quoteId, recipient: ALICE });
    assert.equal(again.code, 409, 'one order per quote');

    const bad = await call('GET', `/api/orders/${o.body.orderId}`, undefined, { 'x-order-key': 'ÿ'.repeat(20) });
    assert.equal(bad.code, 404, 'non-hex keys are a plain 404, not a 502');

    const arr = await call('POST', '/api/quote', { fromId: ['mock-usdt'], amount: '100' });
    assert.equal(arr.code, 400, 'arrays are not accepted where strings are expected');
    const hexAmt = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '0x10' });
    assert.equal(hexAmt.code, 400);
  } finally {
    close();
  }
});

test('pay with ICP: direct quote -> order -> ICP lands -> NAK delivered, no Houdini involved', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => { throw new Error('Houdini must not be used'); } });
  const { call, close } = await serve(createApp({ houdini, ic, pokeEveryMs: 0, houdiniCacheMs: 0 }));
  try {
    const q = await call('POST', '/api/quote-icp', { amount: '2.5' });
    assert.equal(q.code, 200);
    assert.equal(q.body.blocked, null);
    assert.equal(BigInt(q.body.icpIn), 250_000_000n);
    assert.ok(BigInt(q.body.guaranteedNak) < BigInt(q.body.nakOut));
    const o = await call('POST', '/api/orders', { quoteId: q.body.quoteId, recipient: ALICE });
    assert.equal(o.code, 201);
    assert.equal(o.body.route, 'icp');
    assert.equal(o.body.send.symbol, 'ICP');
    assert.equal(o.body.send.amount, '2.5');
    assert.equal(o.body.send.to.length, 64, 'ICP account id to pay');
    assert.match(o.body.send.icrc, /^bkyfl-uyaaa-aaaab-qhl5q-cai-[a-z2-7]{7}\.1$/, 'ICRC-1 account text for Plug/Oisy');
    const stored = ic.orders.get(BigInt(o.body.orderId));
    assert.equal(stored.houdiniId[0], 'icp-direct', 'router order marked as paid directly');
    assert.equal(stored.minNakOut, BigInt(q.body.guaranteedNak), 'same guaranteed minimum as Houdini routes');

    const key = { 'x-order-key': o.body.orderKey };
    const view = `/api/orders/${o.body.orderId}`;
    let s = await call('GET', view, undefined, key);
    assert.equal(s.body.route, 'icp');
    assert.equal(s.body.stage, 'awaitingDeposit');
    assert.equal(BigInt(s.body.receivedIcp), 0n);
    assert.equal(s.body.deposit.icrc, o.body.send.icrc);
    stored.paid = 250_000_000n; // the visitor's wallet pays the deposit account
    s = await call('GET', view, undefined, key);
    assert.equal(s.body.stage, 'completed', 'relay sees the ICP land and nudges the router');

    const again = await call('POST', '/api/orders', { quoteId: q.body.quoteId, recipient: ALICE });
    assert.equal(again.code, 409, 'one order per quote');
    const q2 = await call('POST', '/api/quote-icp', { amount: '2.5' });
    assert.notEqual(q2.body.quoteId, q.body.quoteId, 'a used quote is not served again from the cache');
    assert.equal((await call('POST', '/api/orders', { quoteId: q2.body.quoteId, recipient: ALICE })).code, 201, 'so a second swap of the same amount works');
  } finally {
    close();
  }
});

test('pay with ICP: limits, bad amounts, and the price-impact cap with a suggested amount', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic }));
  try {
    for (const amount of ['abc', '-1', '1.123456789', '0x10', '', '0']) {
      assert.equal((await call('POST', '/api/quote-icp', { amount })).code, 400, `rejects ${JSON.stringify(amount)}`);
    }
    const tiny = await call('POST', '/api/quote-icp', { amount: '0.05' });
    assert.match(tiny.body.blocked, /minimum is 0.1 ICP/);
    const huge = await call('POST', '/api/quote-icp', { amount: '60' });
    assert.match(huge.body.blocked, /maximum is 50 ICP/);
    assert.equal(huge.body.suggestAmount, '50');
    // Fake pool: impact = 1 bps per 0.1 ICP, so 40 ICP is ~4% (over the 3.5% quote cap that
    // sits 1.5 points under the router's 5% refund line).
    const big = await call('POST', '/api/quote-icp', { amount: '40' });
    assert.match(big.body.blocked, /above the 3.5% limit\. Try 35(\.\d+)? ICP or less/);
    const ok = await call('POST', '/api/quote-icp', { amount: '30' });
    assert.equal(ok.body.blocked, null);
    const blockedOrder = await call('POST', '/api/orders', { quoteId: big.body.quoteId, recipient: ALICE });
    assert.equal(blockedOrder.code, 400, 'a blocked quote cannot become an order');
    assert.equal(ic.orders.size, 0);
    const h = await call('GET', '/api/health');
    assert.equal(h.body.limits.quoteImpactPct, 3.5);
    assert.equal(h.body.routes.icp, true);
  } finally {
    close();
  }
});

test('a stricter configured impact limit applies to Houdini routes too', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic, maxQuoteImpactBps: 5 }));
  try {
    const q = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '100' });
    const r = q.body.routes[0];
    assert.match(r.blocked, /above the 0.05% limit\. Try about [\d.]+ or less/);
    assert.ok(r.suggestAmount > 0 && r.suggestAmount < 100);
  } finally {
    close();
  }
});

test('stats strip: public totals, cached', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic }));
  try {
    const a = await call('GET', '/api/stats');
    assert.deepEqual(a.body, { swaps: 3, icpSwapped: 2.5, nakDelivered: 20_000 });
    await call('GET', '/api/stats');
    assert.equal(ic.statsCalls, 1, 'one router query per minute however many visitors');
  } finally {
    close();
  }
});

test('ICRC-1 account text matches the spec vectors; CRC-32 matches the standard check value', () => {
  const owner = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const sub = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  assert.equal(encodeIcrcAccount(owner, sub), `${owner}-dfxgiyy.102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20`);
  const one = new Uint8Array(32);
  one[31] = 1;
  assert.equal(encodeIcrcAccount(owner, one), `${owner}-6cc627i.1`);
  assert.equal(encodeIcrcAccount(owner, new Uint8Array(32)), owner, 'default subaccount is just the principal');
});

test('unpaid direct orders are cancelled after their window (freeing the slot); paid ones are left to the router', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic, directWindowMs: 40, cleanupEveryMs: 30, quoteCacheMs: 0 }));
  try {
    const q1 = await call('POST', '/api/quote-icp', { amount: '1' });
    const q2 = await call('POST', '/api/quote-icp', { amount: '2' });
    const unpaid = await call('POST', '/api/orders', { quoteId: q1.body.quoteId, recipient: ALICE });
    const paid = await call('POST', '/api/orders', { quoteId: q2.body.quoteId, recipient: ALICE });
    assert.ok(Date.parse(unpaid.body.send.expires) - Date.now() < 1_000, 'deposit deadline shown is the direct window');
    ic.orders.get(BigInt(paid.body.orderId)).paid = 200_000_000n;
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(ic.cancelled, [BigInt(unpaid.body.orderId)]);
    assert.ok('awaitingDeposit' in ic.orders.get(BigInt(paid.body.orderId)).status, 'the paid one is untouched');
  } finally {
    close();
  }
});

// Raw request with a chosen Host header (fetch won't set one).
function rawCall(port, method, path, host, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, 'content-type': 'application/json', 'x-real-ip': '203.0.113.9', ...headers } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: buf ? JSON.parse(buf.startsWith('{') ? buf : '{}') : {} }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('audit 2026-10-10: domain redirect, token search cache, 3% direct minimum, payout nudges', async () => {
  const ic = fakeIc();
  let searches = 0;
  const base = createMockHoudini({ payIcp: async () => {} });
  const houdini = Object.assign(Object.create(base), { async searchTokens(...a) { searches += 1; return base.searchTokens(...a); } });
  const server = http.createServer(createApp({ houdini, ic, canonicalHost: 'swap.example.org', pokeEveryMs: 0 }));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const call = (m, p, b, extra) => rawCall(port, m, p, 'swap.example.org', b, extra);
  try {
    // Requests for other host names go to the canonical one (health stays for Railway).
    const r = await rawCall(port, 'GET', '/?x=1', 'relay-production.up.railway.app');
    assert.equal(r.code, 301);
    assert.equal(r.headers.location, 'https://swap.example.org/?x=1');
    assert.equal((await rawCall(port, 'GET', '/api/health', 'relay-production.up.railway.app')).code, 200);
    assert.match((await call('GET', '/api/health')).headers['strict-transport-security'], /includeSubDomains/);
    // A search term is answered from cache for a minute.
    await call('GET', '/api/tokens?term=usdt');
    await call('GET', '/api/tokens?term=usdt');
    assert.equal(searches, 1);
    // Direct ICP: minimum is the quote minus 3%.
    const q = await call('POST', '/api/quote-icp', { amount: '2' });
    assert.equal(BigInt(q.body.guaranteedNak), (BigInt(q.body.nakOut) * 9_700n) / 10_000n);
    const o = await call('POST', '/api/orders', { quoteId: q.body.quoteId, recipient: ALICE });
    assert.equal(o.code, 201);
    assert.equal(ic.orders.get(BigInt(o.body.orderId)).minNakOut, BigInt(q.body.guaranteedNak));
    // A pending payout is nudged when the order page polls.
    const stored = ic.orders.get(BigInt(o.body.orderId));
    stored.status = { payoutPending: { icpIn: 1n, nakAmount: 1n, createdAtTime: 1n } };
    let poked = 0;
    const realPoke = ic.poke;
    ic.poke = async (id) => { poked += 1; return realPoke.call(ic, id); };
    await call('GET', `/api/orders/${o.body.orderId}`, undefined, { 'x-order-key': o.body.orderKey });
    assert.equal(poked, 1);
  } finally {
    server.close();
  }
});

test('token search abuse from one visitor cannot take the token list down for everyone', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic }));
  try {
    let limited = 0;
    for (let i = 0; i < 160; i++) {
      // a different term each time, spread over minutes in real life; the per-minute limit is
      // bypassed here by giving each burst its own fake minute via distinct IPs per 50
      const r = await call('GET', `/api/tokens?term=t${i}`, undefined, { 'x-real-ip': `198.51.100.${Math.floor(i / 50)}` });
      if (r.code === 429) limited += 1;
    }
    assert.equal(limited, 0, 'normal per-visitor volume is not limited site-wide');
    const same = '198.51.100.250';
    let blocked = 0;
    for (let i = 0; i < 200; i++) {
      const r = await call('GET', `/api/tokens?term=x${i}`, undefined, { 'x-real-ip': same });
      if (r.code === 429) blocked += 1;
    }
    assert.ok(blocked > 0, 'one visitor is capped');
    const list = await call('GET', '/api/tokens', undefined, { 'x-real-ip': '203.0.113.99' });
    assert.equal(list.code, 200, 'the default list still works for everyone else');
    assert.ok(list.body.tokens.length > 0);
  } finally {
    close();
  }
});

test('attack surface: methods, sizes, origin lock, concurrency caps', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const secret = 's'.repeat(40);
  const server = http.createServer(createApp({ houdini, ic, originSecret: secret, maxInFlight: 3, maxInFlightPerIp: 2 }));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const H = 'swap.example.org';
  const cf = (ip, extra = {}) => ({ 'x-origin-secret': secret, 'cf-connecting-ip': ip, ...extra });
  try {
    // Origin lock: without the secret only health answers; a wrong secret is refused too.
    assert.equal((await rawCall(port, 'GET', '/', H)).code, 403);
    assert.equal((await rawCall(port, 'GET', '/api/tokens', H, undefined, { 'x-origin-secret': 'x'.repeat(40) })).code, 403);
    assert.equal((await rawCall(port, 'GET', '/api/health', H)).code, 200);
    assert.equal((await rawCall(port, 'GET', '/', H, undefined, cf('198.51.100.1'))).code, 200);
    assert.equal((await rawCall(port, 'HEAD', '/', H, undefined, cf('198.51.100.1'))).code, 200);
    // Methods: no OPTIONS / PUT / DELETE; no HEAD on API calls that do work.
    for (const m of ['OPTIONS', 'PUT', 'DELETE', 'PATCH', 'TRACE']) {
      const r = await rawCall(port, m, '/api/orders', H, undefined, cf('198.51.100.1', { 'content-length': '0' }));
      assert.equal(r.code, 405, m);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await rawCall(port, 'HEAD', '/api/tokens', H, undefined, cf('198.51.100.1'))).code, 405);
    // Oversized URL and declared body are refused before any work.
    assert.equal((await rawCall(port, 'GET', `/api/tokens?term=${'a'.repeat(3000)}`, H, undefined, cf('198.51.100.1'))).code, 414);
    assert.equal((await rawCall(port, 'POST', '/api/quote', H, undefined, cf('198.51.100.1', { 'content-length': '50000' }))).code, 413);
    // Client IP comes from CF-Connecting-IP when the secret is valid: one visitor's order
    // limit doesn't block another behind the same Cloudflare edge address.
    const q1 = await rawCall(port, 'POST', '/api/quote', H, { fromId: 'mock-usdt', amount: '100' }, cf('198.51.100.2'));
    assert.equal(q1.code, 200);
    // Concurrency: slow upstream calls beyond the caps are turned away quickly.
    let release;
    const gate = new Promise((r) => (release = r));
    const realSearch = houdini.searchTokens.bind(houdini);
    houdini.searchTokens = async (...a) => { await gate; return realSearch(...a); };
    const same = [1, 2, 3].map((i) => rawCall(port, 'GET', `/api/tokens?term=s${i}`, H, undefined, cf('198.51.100.3')));
    await new Promise((r) => setTimeout(r, 50));
    const other = [4, 5].map((i) => rawCall(port, 'GET', `/api/tokens?term=o${i}`, H, undefined, cf(`198.51.100.${10 + i}`)));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const codes = (await Promise.all([...same, ...other])).map((r) => r.code);
    assert.deepEqual(codes.slice(0, 3).sort(), [200, 200, 429], 'one visitor: at most 2 at once');
    assert.ok(codes.slice(3).includes(503), 'site-wide: at most 3 at once');
    // Caps release afterwards.
    assert.equal((await rawCall(port, 'GET', '/api/tokens?term=after', H, undefined, cf('198.51.100.3'))).code, 200);
  } finally {
    server.close();
  }
});

test('without the origin lock, Cloudflare headers are ignored (no IP spoofing)', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const { call, close } = await serve(createApp({ houdini, ic }));
  try {
    const q = await call('POST', '/api/quote', { fromId: 'mock-usdt', amount: '100' });
    let last;
    for (let i = 0; i < 7; i++) {
      last = await call('POST', '/api/orders', { quoteId: q.body.routes[0].quoteId, recipient: ALICE }, { 'cf-connecting-ip': `10.9.0.${i}`, 'x-origin-secret': 'guess' });
    }
    assert.equal(last.code, 429);
  } finally {
    close();
  }
});

test('origin lock with a domain: direct page hits redirect there, API hits are refused', async () => {
  const ic = fakeIc();
  const houdini = createMockHoudini({ payIcp: async () => {} });
  const secret = 'z'.repeat(64);
  const server = http.createServer(createApp({ houdini, ic, originSecret: secret, canonicalHost: 'nakswap.lol' }));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const RW = 'relay-production-e42e.up.railway.app';
  try {
    const r = await rawCall(port, 'GET', '/terms?x=1', RW);
    assert.equal(r.code, 301);
    assert.equal(r.headers.location, 'https://nakswap.lol/terms?x=1');
    assert.equal((await rawCall(port, 'GET', '//evil.example/x', RW)).headers.location, 'https://nakswap.lol/x', 'never off-site');
    assert.equal((await rawCall(port, 'GET', '/api/tokens', RW)).code, 403);
    assert.equal((await rawCall(port, 'POST', '/api/quote', RW, { amount: '1' })).code, 403);
    assert.equal((await rawCall(port, 'GET', '/api/health', RW)).code, 200);
    // Through Cloudflare on the domain: served normally.
    assert.equal((await rawCall(port, 'GET', '/', 'nakswap.lol', undefined, { 'x-origin-secret': secret, 'cf-connecting-ip': '198.51.100.9' })).code, 200);
    // www (through Cloudflare) goes to the bare domain.
    assert.equal((await rawCall(port, 'GET', '/', 'www.nakswap.lol', undefined, { 'x-origin-secret': secret })).headers.location, 'https://nakswap.lol/');
  } finally {
    server.close();
  }
});
