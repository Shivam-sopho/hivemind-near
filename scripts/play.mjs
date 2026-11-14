// Play Hivemind from the terminal, signing as a local testnet player account (key in .keys/keys.json).
//   node scripts/play.mjs status <job>
//   node scripts/play.mjs post "<title>" "<what you need>" <writing|research|code|data|marketing> <budget NEAR>
//   node scripts/play.mjs award <job> <agent name, e.g. Quill>
//   node scripts/play.mjs rate <job> <1-5>
//   node scripts/play.mjs dispute <job> "<reason>"
// PLAYER=<account.testnet> selects the account (defaults to the first hive-player-* key).
import { call, view, loadConfig, loadKeys, near, fmtNear, TGAS } from './near.mjs';

const cfg = loadConfig();
const me = process.env.PLAYER || Object.keys(loadKeys()).find((k) => k.startsWith('hive-player-'));
if (!me) { console.error('no player key found; set PLAYER=<account>'); process.exit(1); }
const [cmd, ...a] = process.argv.slice(2);
const charters = Object.fromEntries((await view(cfg.hive, 'get_charters', {})).map((c) => [c.token_id, c]));
const amt = (j, v) => (j.asset === 'Near' ? `${fmtNear(v)} NEAR` : `${(Number(v) / 1e6).toFixed(2)} hUSDC`);
const tx = (r) => console.log(`✓ signed as ${me}\n  https://testnet.nearblocks.io/txns/${r.tx}`);

async function status(id) {
  const j = await view(cfg.hive, 'get_job', { job_id: Number(id) });
  if (!j) return console.log(`no job #${id}`);
  console.log(`#${j.id} "${j.title}" — ${j.status} · budget ${amt(j, j.budget)}${j.price !== '0' ? ` · price ${amt(j, j.price)}` : ''}`);
  for (const f of j.flags) console.log(`  🛡  ${charters[f.by].name}: severity ${f.severity} — ${f.reason}`);
  for (const b of j.bids) console.log(`  💬 ${charters[b.token_id].name.padEnd(8)} ${amt(j, b.price).padEnd(14)} rep ${charters[b.token_id].reputation} — ${b.pitch}`);
  if (j.assignee) console.log(`  👉 assigned to ${charters[j.assignee].name}${j.collaborators.length ? ` + ${j.collaborators.map(([t, bps]) => `${charters[t].name} (${bps / 100}%)`).join(', ')}` : ''}`);
  if (j.result) console.log(`\n${j.result}\n`);
  if (j.status === 'Open' && !j.bids.length) console.log('  … waiting for Sentinel screening and bids (agents act every ~30s)');
  if (j.status === 'Open' && j.bids.length) console.log(`  next: node scripts/play.mjs award ${j.id} <${j.bids.map((b) => charters[b.token_id].name).join('|')}>`);
  if (j.status === 'Assigned') console.log('  … the agent is working on it');
  if (j.status === 'Submitted') console.log(`  next: node scripts/play.mjs rate ${j.id} <1-5>   (or: dispute ${j.id} "reason")`);
}

if (cmd === 'status') await status(a[0]);
else if (cmd === 'post') {
  const r = await call(me, cfg.hive, 'post_job', { title: a[0], spec: a[1], private: false, skill: a[2] || 'writing' }, { deposit: near(a[3] || 0.05), gas: 150n * TGAS });
  tx(r); console.log(`  quest #${r.value} posted`);
} else if (cmd === 'award') {
  const j = await view(cfg.hive, 'get_job', { job_id: Number(a[0]) });
  const bid = j.bids.find((b) => charters[b.token_id].name.toLowerCase() === String(a[1]).toLowerCase());
  if (!bid) { console.log(`no bid from "${a[1]}" — bidders: ${j.bids.map((b) => charters[b.token_id].name).join(', ') || 'none yet'}`); process.exit(1); }
  tx(await call(me, cfg.hive, 'award', { job_id: j.id, token_id: bid.token_id }));
} else if (cmd === 'rate') tx(await call(me, cfg.hive, 'approve', { job_id: Number(a[0]), rating: Number(a[1]) }, { gas: 200n * TGAS }));
else if (cmd === 'dispute') tx(await call(me, cfg.hive, 'dispute', { job_id: Number(a[0]), reason: a[1] || 'quality' }));
else console.log('usage: status|post|award|rate|dispute (see header)');
