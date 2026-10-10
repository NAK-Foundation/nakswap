import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { Principal } from '@icp-sdk/core/principal';
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
  };
  return {
    principal: 'relay-test',
    config,
    orders,
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
        houdiniId: [],
        status: { awaitingDeposit: null },
        paid: 0n,
      };
      orders.set(id, o);
      return o;
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
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { code: res.status, body: await res.json() };
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
  const { call, close } = await serve(createApp({ houdini, ic }));
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
    await call('GET', `/api/orders/${o.body.orderId}`); // triggers mock payout
    await new Promise((r) => setTimeout(r, 20));
    const s = await call('GET', `/api/orders/${o.body.orderId}`);
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
