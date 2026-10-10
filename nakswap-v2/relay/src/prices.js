// USD prices for ICP and NAK from ICPSwap's public info API, refreshed every 5 minutes.
// Used only to show the user the swap limits in dollars; swaps never depend on it.
const URL_FOR = (ledger) => `https://api.icpswap.com/info/token/${ledger}`;
const ICP = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const NAK = 'eig2s-waaaa-aaaam-qbg5a-cai';

export function createPrices({ fetchImpl = fetch, intervalMs = 5 * 60_000 } = {}) {
  const state = { icpUsd: null, nakUsd: null, at: null };
  async function load(ledger) {
    const res = await fetchImpl(URL_FOR(ledger), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    const p = Number(body?.data?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  }
  async function refresh() {
    try {
      const [icp, nak] = await Promise.all([load(ICP), load(NAK)]);
      if (icp) state.icpUsd = icp;
      if (nak) state.nakUsd = nak;
      state.at = Date.now();
    } catch {
      // keep the last good values
    }
  }
  refresh();
  setInterval(refresh, intervalMs).unref();
  return state;
}
