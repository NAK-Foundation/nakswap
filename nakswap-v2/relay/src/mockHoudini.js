// Stand-in for Houdini with the same interface as houdini.js. No network: quotes come
// from a fixed rate table, and an exchange "settles" by calling `payIcp(accountIdHex, e8s)`,
// which on a local replica sends ICP to the router's deposit account the way a real
// exchange payout would.
import crypto from 'node:crypto';

const TOKENS = [
  { id: 'mock-eth', symbol: 'ETH', name: 'Ethereum', chain: 'ethereum', decimals: 18, usd: 3000 },
  { id: 'mock-usdt', symbol: 'USDT', name: 'Tether (Tron)', chain: 'tron', decimals: 6, usd: 1 },
  { id: 'mock-sol', symbol: 'SOL', name: 'Solana', chain: 'solana', decimals: 9, usd: 150 },
  { id: 'mock-icp', symbol: 'ICP', name: 'Internet Computer', chain: 'icp', decimals: 8, usd: 3 },
];

export function createMockHoudini({ payIcp, settleAfterMs = 5_000, icpUsd = 3 }) {
  const quotes = new Map();
  const orders = new Map();

  function advance(o) {
    if (o.status === 4 || o.status === 5) return;
    const age = Date.now() - o.createdMs;
    if (age > settleAfterMs && !o.paying) {
      o.paying = true;
      const e8s = BigInt(Math.floor(o.outAmount * 1e8));
      payIcp(o.receiverAddress, e8s)
        .then(() => {
          o.status = 4;
          o.statusLabel = 'COMPLETED';
        })
        .catch((e) => {
          o.status = 6;
          o.statusLabel = 'FAILED';
          o.message = String(e);
        });
    } else if (age > settleAfterMs / 2 && o.status === 0) {
      o.status = 2;
      o.statusLabel = 'EXCHANGING';
    }
  }

  return {
    mode: 'mock',

    async searchTokens(term) {
      const t = (term || '').toLowerCase();
      return TOKENS.filter((x) => x.symbol.toLowerCase().includes(t) || x.name.toLowerCase().includes(t));
    },

    async icpToken() {
      return TOKENS.find((t) => t.symbol === 'ICP');
    },

    async quotesToIcp({ fromId, amount }) {
      const from = TOKENS.find((t) => t.id === fromId);
      if (!from) return [];
      const usd = Number(amount) * from.usd;
      return ['standard', 'private'].map((type) => {
        const quoteId = crypto.randomUUID();
        const haircut = type === 'private' ? 0.985 : 0.992;
        const q = {
          quoteId,
          type,
          swap: 'mock',
          swapName: `Mock ${type}`,
          amountIn: Number(amount),
          amountOut: Number(((usd / icpUsd) * haircut).toFixed(8)),
          duration: type === 'private' ? 25 : 8,
          min: 0,
          max: 1e9,
          fromSymbol: from.symbol,
        };
        quotes.set(quoteId, { ...q, created: Date.now() });
        return q;
      });
    },

    async createExchange({ quoteId, addressTo }) {
      const q = quotes.get(quoteId);
      if (!q) throw Object.assign(new Error('quote not found or expired'), { status: 422 });
      const houdiniId = crypto.randomBytes(11).toString('base64url');
      const o = {
        houdiniId,
        created: new Date().toISOString(),
        expires: new Date(Date.now() + 30 * 60_000).toISOString(),
        depositAddress: `mock-${q.fromSymbol.toLowerCase()}-deposit-${houdiniId}`,
        receiverAddress: addressTo,
        status: 0,
        statusLabel: 'WAITING',
        inAmount: q.amountIn,
        inSymbol: q.fromSymbol,
        outAmount: q.amountOut,
        outSymbol: 'ICP',
        eta: q.duration,
        createdMs: Date.now(),
      };
      orders.set(houdiniId, o);
      return o;
    },

    async getOrder(houdiniId) {
      const o = orders.get(houdiniId);
      if (!o) throw Object.assign(new Error('not found'), { status: 404 });
      advance(o);
      const { createdMs, paying, ...pub } = o;
      return pub;
    },
  };
}
