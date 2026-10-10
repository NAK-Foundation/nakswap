// Houdini Partner API v2 client. Backend only: the key and secret never reach a browser.
// Docs: https://docs.houdiniswap.com/developer-hub/swap-flows/standard-swap
const BASE = 'https://api-partner.houdiniswap.com/v2';

export const ORDER_STATUS = {
  0: 'WAITING',
  1: 'CONFIRMING',
  2: 'EXCHANGING',
  3: 'ANONYMIZING',
  4: 'COMPLETED',
  5: 'EXPIRED',
  6: 'FAILED',
  7: 'REFUNDED',
  8: 'DELETED',
};

export class HoudiniError extends Error {
  constructor(status, body) {
    // Houdini returns { code, message }; show its message rather than the raw JSON.
    const msg = body && typeof body === 'object' && body.message ? body.message : typeof body === 'string' ? body : JSON.stringify(body);
    super(`Houdini: ${String(msg).slice(0, 300)}`);
    this.expose = true; // Houdini's own wording (minimums, limits) is meant for the user
    this.code = body?.code;
    this.status = status;
    this.body = body;
  }
}

export function createHoudini({ apiKey, apiSecret, fetchImpl = fetch, base = BASE }) {
  const ready = Boolean(apiKey && apiSecret);

  // Houdini rejects calls without the end user's IP, user agent and timezone (AML rules).
  async function call(method, path, { query, body, user } = {}) {
    if (!ready) {
      throw Object.assign(new Error('Houdini API key is not set on the relay (HOUDINI_API_KEY / HOUDINI_API_SECRET)'), {
        status: 503,
      });
    }
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === '') continue;
      // Array params use repeated keys (OpenAPI form/explode), e.g. types=standard&types=private.
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `${apiKey}:${apiSecret}`,
        'Content-Type': 'application/json',
        'x-user-ip': user?.ip || '0.0.0.0',
        'x-user-agent': user?.agent || 'nakswap-relay',
        'x-user-timezone': user?.timezone || 'UTC',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000), // a hung Houdini call must not pin the request
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) throw new HoudiniError(res.status, data);
    return data;
  }

  let icpTokenCache = null;

  return {
    mode: 'live',
    ready,

    // Houdini's `term` matches names loosely (e.g. "usdt" misses Tether), so a symbol-like
    // term is also looked up by exact symbol and the two result sets are merged.
    async searchTokens(term, user) {
      const base = { hasCex: true, page: 1 };
      const lookups = [call('GET', '/tokens', { query: { ...base, term: term || undefined, pageSize: term ? 30 : 60 }, user })];
      if (term && /^[a-z0-9.]{2,12}$/i.test(term)) {
        lookups.push(call('GET', '/tokens', { query: { ...base, symbol: term.toUpperCase(), pageSize: 30 }, user }));
      }
      const results = await Promise.allSettled(lookups);
      const seen = new Set();
      const out = [];
      for (const r of [...results].reverse()) {
        if (r.status !== 'fulfilled') continue;
        for (const t of r.value.tokens || []) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          out.push(t);
        }
      }
      if (!out.length && results.every((r) => r.status === 'rejected')) throw results[0].reason;
      return out;
    },

    // ICP on the Internet Computer chain (chain key "icp"); cached for the process lifetime.
    async icpToken(user) {
      if (icpTokenCache) return icpTokenCache;
      const { tokens } = await call('GET', '/tokens', {
        query: { chain: 'icp', symbol: 'ICP', hasCex: true, pageSize: 20, page: 1 },
        user,
      });
      const tok = (tokens || []).find((t) => t.chain === 'icp' && t.symbol === 'ICP');
      if (!tok) throw new Error('ICP (Internet Computer chain) not found in Houdini token list');
      icpTokenCache = tok;
      return tok;
    },

    // Quotes for `amount` (human units) of `fromId` into ICP. Standard + private routes only:
    // DEX routes need the user's wallet to sign on the source chain, which this flow avoids.
    async quotesToIcp({ fromId, amount, refundAddress, user }) {
      const icp = await this.icpToken(user);
      const { quotes } = await call('GET', '/quotes', {
        query: { from: fromId, to: icp.id, amount, types: ['standard', 'private'], refundAddress },
        user,
      });
      return quotes || [];
    },

    async createExchange({ quoteId, addressTo, refundAddress, user }) {
      return call('POST', '/exchanges', { body: { quoteId, addressTo, refundAddress }, user });
    },

    async getOrder(houdiniId, user) {
      return call('GET', `/orders/${encodeURIComponent(houdiniId)}`, { user });
    },
  };
}
