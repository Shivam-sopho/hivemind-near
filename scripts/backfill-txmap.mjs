// One-time backfill of the event → transaction map for events emitted before exact recording began
// (agents now record hashes straight from each transaction's EVENT_JSON logs). Pages the NearBlocks
// index of hive transactions gently and matches each old event by signer + timestamp (±2.5 s).
// Idempotent: exits immediately once the old history is covered. Writes into .keys/txmap-new.json,
// which `publish-txmap.mjs` merges into the public map.
import fs from 'node:fs';
import { view, loadConfig } from './near.mjs';

const cfg = loadConfig();
const OUT = process.argv[2] || '.keys/txmap-new.json';
const EXACT_FROM = 837; // first event recorded exactly
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

let map = {};
try { map = await (await fetch(`https://raw.githubusercontent.com/Shivam-sopho/hivemind-near/txmap/txmap.json?t=${Date.now()}`)).json(); } catch {}
try { map = { ...map, ...JSON.parse(fs.readFileSync(OUT, 'utf8')) }; } catch {}

const events = [];
const total = (await view(cfg.hive, 'get_stats')).events;
for (let from = 0; from < Math.min(total, EXACT_FROM); from += 100) events.push(...(await view(cfg.hive, 'get_events', { from, limit: 100 })));
const missing = events.filter((e) => e.idx < EXACT_FROM && !map[e.idx]);
const coverage = 1 - missing.length / Math.max(1, Math.min(total, EXACT_FROM));
console.log(`old events: ${Math.min(total, EXACT_FROM)}, mapped: ${(coverage * 100).toFixed(0)}%`);
if (coverage >= 0.9 || process.env.SKIP_BACKFILL) process.exit(0);

const oldest = Math.min(...missing.map((e) => e.ts));
const txs = [];
let cursor = '';
for (let page = 0; page < 40; page++) {
  const url = `https://api-testnet.nearblocks.io/v1/account/${cfg.hive}/txns?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  let d = null;
  for (let tries = 0; tries < 4 && !d; tries++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      if (Array.isArray(j.txns)) d = j; else { console.log('nearblocks:', JSON.stringify(j).slice(0, 120)); await sleep(30_000); }
    } catch { await sleep(10_000); }
  }
  if (!d) break;
  for (const t of d.txns) txs.push({ hash: t.transaction_hash, ts: Number(String(t.receipt_block?.block_timestamp ?? t.block_timestamp).slice(0, 13)), from: t.predecessor_account_id });
  cursor = d.cursor;
  const last = txs[txs.length - 1];
  process.stdout.write(`page ${page + 1}: ${txs.length} txs, back to ${new Date(last?.ts || 0).toISOString().slice(11, 19)}\n`);
  if (!cursor || (last && last.ts < oldest - 60_000)) break;
  await sleep(1500);
}

let added = 0;
for (const e of missing) {
  let best = null;
  for (const t of txs) {
    if (t.from !== e.actor) continue;
    const dt = Math.abs(t.ts - e.ts);
    if (dt <= 2500 && (!best || dt < best.dt)) best = { ...t, dt };
  }
  if (best) { map[e.idx] = best.hash; added++; }
}
fs.mkdirSync('.keys', { recursive: true });
let out = {}; try { out = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
for (const e of missing) if (map[e.idx]) out[e.idx] = map[e.idx];
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`backfill: matched ${added}/${missing.length} older events from ${txs.length} indexed txs`);
