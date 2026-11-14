// Find the exact transaction behind hive events straight from NEAR RPC (no indexer):
//   event.ts is the timestamp (ms) of the block whose receipt emitted it → locate that block by height
//   search, then scan its chunks (and the preceding blocks) for the transaction signed by the event's
//   actor (or, for contract-relayed events like hUSDC jobs and DAO votes, the tx that targeted that contract).
//   node scripts/link-from-chain.mjs 98 99 105 108      # by job id
//   node scripts/link-from-chain.mjs --events 800-900   # by event index range
// Writes into .keys/txmap-new.json; publish with scripts/publish-txmap.mjs.
import fs from 'node:fs';
import { view, loadConfig } from './near.mjs';

const cfg = loadConfig();
const RPC = (process.env.NEAR_RPC || 'https://near-testnet.drpc.org,https://rpc.testnet.near.org').split(',');
async function rpc(method, params) {
  for (let round = 0; round < 4; round++) for (const url of RPC) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const d = await r.json(); if (d.result) return d.result; if (d.error?.cause?.name === 'UNKNOWN_BLOCK') return null;
    } catch {}
  }
  throw new Error(`rpc ${method} failed`);
}
const blockCache = new Map();
const block = async (h) => { if (!blockCache.has(h)) blockCache.set(h, await rpc('block', { block_id: h })); return blockCache.get(h); };
const tsOf = (b) => Math.floor(Number(BigInt(b.header.timestamp_nanosec) / 1000000n));

// locate the block whose timestamp (ms) equals ts
let anchor = null;
async function heightFor(ts) {
  if (!anchor) { const b = await rpc('block', { finality: 'final' }); const b2 = await block(b.header.height - 5000); anchor = { h: b.header.height, ts: tsOf(b), rate: (tsOf(b) - tsOf(b2)) / 5000 }; }
  let lo = Math.max(1, Math.floor(anchor.h - (anchor.ts - ts) / anchor.rate) - 400), hi = lo + 800;
  while ((await block(lo)) && tsOf(await block(lo)) > ts) lo -= 800;
  while ((await block(hi)) && tsOf(await block(hi)) < ts) hi += 800;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; const b = await block(mid); if (!b || tsOf(b) < ts) lo = mid; else hi = mid; }
  for (const h of [hi, lo, hi + 1]) { const b = await block(h); if (b && Math.abs(tsOf(b) - ts) <= 1) return h; }
  return hi;
}
async function txsInBlock(h) {
  const b = await block(h); if (!b) return [];
  const out = [];
  await Promise.all(b.chunks.filter((c) => c.tx_root !== '11111111111111111111111111111111').map(async (c) => {
    const ch = await rpc('chunk', { chunk_id: c.chunk_hash }); if (ch) out.push(...ch.transactions);
  }));
  return out;
}
const RELAYED = { [cfg.usdc]: true, [cfg.honey]: true, [cfg.dao]: true };
async function findTx(e) {
  const h = await heightFor(e.ts);
  for (let back = 0; back <= 6; back++) {
    const txs = await txsInBlock(h - back);
    const hit = RELAYED[e.actor]
      ? txs.find((t) => t.receiver_id === e.actor && (e.actor !== cfg.dao || t.actions?.some?.((a) => a.FunctionCall?.method_name === 'act_proposal')))
      : txs.find((t) => t.signer_id === e.actor && t.receiver_id === cfg.hive);
    if (hit) return hit.hash;
  }
  return null;
}

const args = process.argv.slice(2);
const total = (await view(cfg.hive, 'get_stats')).events;
let events = [];
let published = {};
try { published = await (await fetch(`https://raw.githubusercontent.com/Shivam-sopho/hivemind-near/txmap/txmap.json?t=${Date.now()}`)).json(); } catch {}
if (args[0] === '--recent') {
  // CI mode: link the most recent N events that the public map doesn't have yet
  const n = Number(args[1] || 150);
  for (let f = Math.max(0, total - n); f < total; f += 100) events.push(...(await view(cfg.hive, 'get_events', { from: f, limit: 100 })));
  events = events.filter((e) => !published[e.idx]);
}
else if (args[0] === '--events') { const [a, b] = args[1].split('-').map(Number); for (let f = a; f <= Math.min(b, total - 1); f += 100) events.push(...(await view(cfg.hive, 'get_events', { from: f, limit: Math.min(100, b - f + 1) }))); }
else {
  const ids = new Set(args.map(Number));
  for (let f = Math.max(0, total - 400); f < total; f += 100) events.push(...(await view(cfg.hive, 'get_events', { from: f, limit: 100 })));
  events = events.filter((e) => ids.has(e.job));
}
const OUT = '.keys/txmap-new.json';
let out = {}; try { out = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
let found = 0;
for (const e of events) {
  if (out[e.idx]) { found++; continue; }
  const hash = await findTx(e).catch(() => null);
  if (hash) { out[e.idx] = hash; found++; }
  console.log(`#${e.idx} job ${e.job ?? '-'} ${e.kind.padEnd(13)} ${hash ? hash : 'not found'}`);
}
fs.mkdirSync('.keys', { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`linked ${found}/${events.length}`);
