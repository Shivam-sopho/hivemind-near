// Re-runnable investment thesis: "AI agent economies are NEAR's next demand driver."
// Pulls NEAR mainnet daily stats from the NearBlocks public API, computes growth/fee baselines,
// and writes web/data/thesis.json (consumed by the dashboard, which also runs the demand model live).
//   node thesis/model.mjs
import fs from 'node:fs';

const API = 'https://api.nearblocks.io/v1';
const get = async (p) => (await fetch(`${API}${p}`, { signal: AbortSignal.timeout(30_000) })).json();

const [{ charts }, { stats }] = await Promise.all([get('/charts'), get('/stats')]);
const rows = charts
  .map((d) => ({
    date: d.date.slice(0, 10),
    txns: Number(d.txns),
    active_accounts: Number(d.active_accounts || 0),
    new_accounts: Number(d.new_accounts || 0),
    fee_near: Number(d.txn_fee || 0) / 1e24,
    fee_usd: Number(d.txn_fee_usd || 0),
    price: Number(d.near_price || 0),
  }))
  .sort((a, b) => a.date.localeCompare(b.date));

const last = (n) => rows.slice(-n);
const avg = (arr, k) => arr.reduce((s, r) => s + r[k], 0) / arr.length;
const d30 = last(30);
const d30y = rows.slice(-395, -365);
const d365 = last(365);
const txGrowth = avg(d30, 'txns') / avg(d30y, 'txns');
const aaGrowth = avg(d30, 'active_accounts') / Math.max(1, avg(d30y, 'active_accounts'));
const feePerTx = avg(d30, 'fee_near') / avg(d30, 'txns');
const feeUsdPerTx = avg(d30, 'fee_usd') / avg(d30, 'txns');
const peak = d365.reduce((m, r) => (r.txns > m.txns ? r : m), d365[0]);
const s = stats[0];
const pct = (x) => `${x >= 1 ? '+' : ''}${(x * 100 - 100).toFixed(0)}%`;

const out = {
  title: txGrowth < 1
    ? "Human usage alone won't carry NEAR. Agent commerce is the most credible next demand driver, and NEAR is already built for it"
    : 'NEAR is the cheapest place for AI agents to do business, and agent commerce is a step change in demand',
  summary:
    'The thesis: AI agents transact far more often than humans, at much smaller ticket sizes. That needs very cheap fees, fast finality, named accounts, scoped keys and cross-chain settlement. NEAR ships all of these today (function-call keys, chain signatures, Intents, sharding). Hivemind is a working example: one job is about 6 txs. The claims below are computed from live mainnet data, including the ones that cut against the thesis. The model shows what agent adoption would have to look like to change the trend.',
  claims: [
    {
      claim: `Fees are negligible for micro-commerce: ~$${feeUsdPerTx.toFixed(5)} per tx (30-day avg)`,
      evidence: `30-day average fee of ${feePerTx.toExponential(2)} NEAR per tx at a ${Number(s.gas_price) / 1e9} Ggas price, an average that includes heavy contract calls. A full Hivemind job lifecycle (~6 txs) is about $${(6 * feeUsdPerTx).toFixed(3)} at that average; simple calls cost less.`,
    },
    {
      claim: txGrowth < 1 ? `Bear case first: daily transactions ${pct(txGrowth)} year over year, so NEAR needs a new demand source` : `Daily transactions ${pct(txGrowth)} year over year`,
      evidence: `30-day avg ${Math.round(avg(d30, 'txns')).toLocaleString('en-US')} tx/day vs ${Math.round(avg(d30y, 'txns')).toLocaleString('en-US')} a year earlier. The 365-day peak was ${peak.txns.toLocaleString('en-US')} on ${peak.date}.`,
    },
    {
      claim: `Daily active accounts ${pct(aaGrowth)} year over year: today's demand is too human-paced`,
      evidence: `30-day avg ${Math.round(avg(d30, 'active_accounts')).toLocaleString('en-US')} daily active accounts. Each agent here is a sub-account with a scoped function-call key, so agent fleets add accounts without adding seed phrases.`,
    },
    {
      claim: 'Agent volume is non-linear: 100k agents doing 10 jobs/day ≈ 6M tx/day',
      evidence: `That is about ${((100000 * 10 * 6) / avg(d30, 'txns')).toFixed(1)}× NEAR's current daily volume. Use the sliders to test your own assumptions. NEAR's sharded design is built to absorb this without fee spikes.`,
    },
    {
      claim: 'Risk: the value of agent commerce may accrue to stablecoins, not NEAR',
      evidence: 'Mitigants: 70% of gas is burned on every tx regardless of the asset being moved, and NEAR Intents plus chain signatures keep NEAR as the coordination layer even for cross-chain flows. Track settled stablecoin volume vs gas burned as agent apps launch.',
    },
  ],
  baseline: {
    avg_daily_txns_30d: Math.round(avg(d30, 'txns')),
    avg_fee_near_per_tx: feePerTx,
    avg_fee_usd_per_tx: feeUsdPerTx,
    near_price: Number(s.near_price),
    total_txns: Number(s.total_txns),
    market_cap: Number(s.market_cap),
  },
  model: { agents: 100000, jobs_per_agent_day: 10, txs_per_job: 6, avg_job_usd: 2 },
  series: d365.map((r) => ({ date: r.date, txns: r.txns, active_accounts: r.active_accounts })),
  sources: ['api.nearblocks.io/v1/charts', 'api.nearblocks.io/v1/stats'],
  generated_at: new Date().toISOString(),
};
fs.mkdirSync('web/data', { recursive: true });
fs.writeFileSync('web/data/thesis.json', JSON.stringify(out));
console.log(out.claims.map((c) => '• ' + c.claim).join('\n'));
