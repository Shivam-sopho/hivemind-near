// Hivemind live verifier: checks every major README claim against NEAR testnet.
// No keys, no accounts, no setup needed beyond `npm ci`.
//   npm run verify            (or: node scripts/verify.mjs)
// Exit code 0 = all checks passed.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseDecode, baseEncode } from 'near-api-js';
import { keccak_256 } from '@noble/hashes/sha3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'config.json'), 'utf8'));
const RPCS = (process.env.NEAR_RPC || 'https://rpc.testnet.near.org,https://near-testnet.drpc.org,https://test.rpc.fastnear.com').split(',');

async function rpc(method, params) {
  let last;
  for (let round = 0; round < 3; round++) {
    for (const url of RPCS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const d = await r.json();
        if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 200));
        if (d.result?.error) throw new Error(String(d.result.error).slice(0, 200));
        return d.result;
      } catch (e) { last = e; }
    }
    await new Promise((s) => setTimeout(s, 1000 * (round + 1)));
  }
  throw last;
}
const view = async (account_id, method_name, args = {}) => {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
};
const account = (account_id) => rpc('query', { request_type: 'view_account', finality: 'final', account_id });
const keys = (account_id) => rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id });

let pass = 0, fail = 0;
const ok = (name, cond, evidence) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${evidence ? `\n      ↳ ${evidence}` : ''}`);
};
const section = (t) => console.log(`\n\x1b[33m■ ${t}\x1b[0m`);
const E = (a) => `https://testnet.nearblocks.io/address/${a}`;
const yocto = (v) => (Number(BigInt(v) / 10n ** 18n) / 1e6).toFixed(4);

console.log(`Hivemind live verification against NEAR testnet (${RPCS[0]})\nhive=${cfg.hive}\n`);

// ── 1. Contracts are deployed and match the WASM in this repo ──
section('1. Contracts deployed; on-chain code = res/*.wasm in this repo');
for (const [name, acc, wasm] of [['hive', cfg.hive, 'res/hive.wasm'], ['HONEY', cfg.honey, 'res/honey.wasm'], ['hUSDC', cfg.usdc, 'res/honey.wasm']]) {
  const a = await account(acc);
  const local = baseEncode(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, wasm))).digest());
  ok(`${name} contract code hash matches ${wasm}`, a.code_hash === local, `${acc} code_hash=${a.code_hash} · local sha256(base58)=${local}`);
}

// ── 2. Governance: Sputnik DAO owns the hive, admin renounced ──
section('2. Social money: Sputnik DAO governs the hive, bootstrap admin renounced');
const stats = await view(cfg.hive, 'get_stats');
ok('hive.owner is the Sputnik DAO', stats.owner === cfg.dao, `owner=${stats.owner} (${E(cfg.dao)})`);
ok('bootstrap admin is renounced (admin = null)', stats.admin === null, `admin=${stats.admin}`);
const policy = await view(cfg.dao, 'get_policy');
const lastProp = await view(cfg.dao, 'get_last_proposal_id');
const props = lastProp ? await view(cfg.dao, 'get_proposals', { from_index: 0, limit: Math.min(lastProp, 100) }) : [];
const fc = props.filter((p) => p.kind?.FunctionCall?.receiver_id === cfg.hive && p.status === 'Approved');
ok('DAO has approved FunctionCall proposals executed on the hive', fc.length >= 1, fc.map((p) => `#${p.id} ${p.kind.FunctionCall.actions[0].method_name}`).join(', '));
const resolves = fc.filter((p) => p.kind.FunctionCall.actions[0].method_name === 'resolve');
ok('at least one dispute was resolved by DAO vote', resolves.length >= 1, resolves.map((p) => `#${p.id}: ${p.description.slice(0, 80)}`).join(' | ') || 'none yet');
ok('DAO council policy present', Array.isArray(policy.roles), `roles=${policy.roles.map((r) => r.name).join(',')} bond=${yocto(policy.proposal_bond)} NEAR`);

// ── 3. NFTs that own money (NEP-171 dynamic charters) ──
section('3. NFTs that do something: NEP-171 charters own the agent treasury, dynamic on-chain SVG');
const meta = await view(cfg.hive, 'nft_metadata');
const supply = await view(cfg.hive, 'nft_total_supply');
ok('NEP-171 metadata + supply', meta.spec?.startsWith('nft-') && Number(supply) === stats.charters, `spec=${meta.spec} symbol=${meta.symbol} supply=${supply} charters=${stats.charters}`);
const charters = await view(cfg.hive, 'get_charters', {});
const tok = await view(cfg.hive, 'nft_token', { token_id: charters[0].token_id });
ok('charter NFT carries an on-chain SVG and live stats', tok.metadata.media.startsWith('data:image/svg+xml') && JSON.parse(tok.metadata.extra).reputation === charters[0].reputation, `token #${tok.token_id} owner=${tok.owner_id} extra=${tok.metadata.extra.slice(0, 90)}…`);
const rich = charters.filter((c) => BigInt(c.earned_near) > 0n || BigInt(c.earned_usdc) > 0n);
ok('charters hold earnings (NFT owns money)', rich.length >= 1, rich.map((c) => `${c.name}: earned ${yocto(c.earned_near)} NEAR + ${(Number(c.earned_usdc) / 1e6).toFixed(2)} hUSDC`).join(' · '));

// ── 4. Chain signatures: recompute every agent's EVM address from the NEAR MPC network ──
section('4. Chain signatures: each agent\'s EVM address re-derived from v1.signer-prod.testnet');
for (const c of charters) {
  const pk = await view('v1.signer-prod.testnet', 'derived_public_key', { path: c.chainsig_path, predecessor: c.agent, domain_id: 0 });
  const evm = '0x' + Buffer.from(keccak_256(baseDecode(pk.split(':')[1])).slice(-20)).toString('hex');
  ok(`${c.name} chain-sig address re-derives correctly`, c.foreign_address === `eip155:${evm}`, `path=${c.chainsig_path} → ${evm}`);
}

// ── 5. Agent security: function-call keys, policy engine ──
section('5. AI security: agents hold scoped function-call keys; policy engine on every charter');
for (const c of charters) {
  const k = await keys(c.agent);
  const fck = k.keys.filter((x) => x.access_key.permission?.FunctionCall?.receiver_id === cfg.hive);
  const methods = fck[0]?.access_key.permission.FunctionCall.method_names || [];
  ok(`${c.name} has a function-call key scoped to the hive`, fck.length >= 1 && !methods.includes('withdraw'), `methods=[${methods.join(', ')}] (no withdraw)`);
}
const pol = charters[0].policy;
ok('policy engine fields on charters', pol.daily_limit_near && pol.max_collab_bps >= 0, `daily_limit=${yocto(pol.daily_limit_near)} NEAR + ${(Number(pol.daily_limit_usdc) / 1e6).toFixed(0)} hUSDC, max_bid=${yocto(pol.max_bid)} NEAR, hire cap=${pol.max_collab_bps / 100}%`);

// ── 6. Job market, Sentinel, private AI ──
section('6. Agent economy / swarms: job market, hiring, Sentinel screening, private TEE jobs');
const jobs = [];
let before;
for (;;) { const page = await view(cfg.hive, 'get_jobs', { before, limit: 50 }); if (!page.length) break; jobs.push(...page); before = Math.min(...page.map((j) => j.id)); if (before <= 1) break; }
const by = (st) => jobs.filter((j) => j.status === st);
ok('jobs posted and settled', stats.jobs > 10 && stats.jobs_completed > 5, `jobs=${stats.jobs} completed=${stats.jobs_completed} volume=${yocto(stats.volume_near)} NEAR + ${(Number(stats.volume_usdc) / 1e6).toFixed(2)} hUSDC`);
const hired = jobs.filter((j) => j.status === 'Completed' && j.collaborators.length);
ok('agents hired other agents for revenue shares', hired.length >= 1, hired.slice(0, 3).map((j) => `#${j.id} collaborator=${j.collaborators.map(([t, b]) => `#${t}@${b / 100}%`).join(',')}`).join(' · '));
const blocked = by('Flagged').filter((j) => j.flags.some((f) => f.severity >= 3));
ok('Sentinel blocked scam / prompt-injection jobs on-chain', blocked.length >= 1, blocked.slice(0, 2).map((j) => `#${j.id} "${j.title}" → ${j.flags[0].reason.slice(0, 70)}`).join(' | '));
const usdcJobs = jobs.filter((j) => j.asset === 'Usdc' && j.status === 'Completed');
ok('stablecoin (hUSDC, NEP-141) jobs settle via ft_transfer_call', usdcJobs.length >= 1, `${usdcJobs.length} completed hUSDC jobs`);
const priv = jobs.filter((j) => j.private && /signer=0x[0-9a-f]+/i.test(j.attestation || ''));
ok('private jobs: ciphertext on-chain + NEAR AI TEE attestation commitment', priv.length >= 1 && priv.every((j) => j.spec.startsWith('enc:v1:') && j.result?.startsWith('enc:v1:')), priv.slice(0, 2).map((j) => `#${j.id} ${j.attestation.slice(0, 96)}…`).join(' | '));
const refunded = by('Refunded');
ok('disputes refund the client and slash the agent', refunded.length >= 1 && charters.some((c) => c.jobs_failed > 0), `refunded=${refunded.map((j) => '#' + j.id).join(',')} · agents with failures: ${charters.filter((c) => c.jobs_failed).map((c) => `${c.name}(${c.jobs_failed})`).join(', ')}`);

// ── 7. HONEY memecoin mechanics ──
section('7. Memecoin with mechanics: HONEY minted only by labor, halving, evaporation');
const hs = await view(cfg.honey, 'token_stats');
const hm = await view(cfg.honey, 'ft_metadata');
ok('HONEY minter is the hive (proof-of-labor, no premine)', hs.minter === cfg.hive, `minter=${hs.minter} symbol=${hm.symbol}`);
ok('1% evaporation on wallet transfers configured', hs.transfer_burn_bps === 100, `transfer_burn_bps=${hs.transfer_burn_bps}`);
ok('supply == minted − burned (no other issuance)', BigInt(hs.total_supply) === BigInt(hs.total_minted) - BigInt(hs.total_burned), `supply=${hs.total_supply} minted=${hs.total_minted} burned=${hs.total_burned}`);
ok('HONEY has actually been burned (1% evaporation and/or dispute slashing)', BigInt(hs.total_burned) > 0n, `total_burned=${Number(BigInt(hs.total_burned) / 10n ** 15n) / 1e3} HONEY · staked on charters: ${charters.filter((c) => BigInt(c.honey_staked) > 0n).map((c) => `${c.name} ${Number(BigInt(c.honey_staked) / 10n ** 18n)}`).join(', ') || 'none'}`);
ok('halving schedule active', BigInt(stats.honey_reward_now) === (100n * 10n ** 18n) >> BigInt(stats.honey_epoch) || stats.honey_epoch >= 7, `epoch=${stats.honey_epoch} reward_now=${Number(BigInt(stats.honey_reward_now) / 10n ** 15n) / 1e3} HONEY`);

// ── 8. Real-world money: payroll streams, treasury ──
section('8. Real-world money: DAO payroll streams from the fee treasury');
const streams = await view(cfg.hive, 'get_streams');
ok('payroll stream created by DAO proposal', streams.length >= 1 && fc.some((p) => p.kind.FunctionCall.actions[0].method_name === 'create_stream'), streams.map((s) => `#${s.id} → ${s.recipient}: ${Number(s.amount_per_period) / 1e6} hUSDC × ${s.periods}`).join(' · '));
ok('treasury accrues the 5% protocol fee', stats.fee_bps === 500 && (BigInt(stats.treasury_near) > 0n || BigInt(stats.treasury_usdc) > 0n), `fee=${stats.fee_bps}bps treasury=${yocto(stats.treasury_near)} NEAR + ${(Number(stats.treasury_usdc) / 1e6).toFixed(2)} hUSDC`);

// ── 9. DeFi: NEAR Intents treasury plans recorded on-chain (+ live API reachability) ──
section('9. Unstoppable DeFi: NEAR Intents 1Click quotes recorded on-chain by the treasury agent');
const events = await view(cfg.hive, 'get_events', { limit: 100 });
const plans = events.filter((e) => e.kind === 'treasury_plan' && /1Click quote/.test(e.text));
ok('treasury agent logged live 1Click quotes on-chain', plans.length >= 1, plans.slice(-1).map((e) => e.text).join(''));
try {
  const r = await fetch('https://1click.chaindefuser.com/v0/tokens', { signal: AbortSignal.timeout(15_000) });
  const t = await r.json();
  ok('NEAR Intents 1Click API reachable (live)', Array.isArray(t) && t.length > 50, `${t.length} assets listed`);
} catch (e) { ok('NEAR Intents 1Click API reachable (live)', false, e.message); }

// ── 10. Privacy: NEAR AI Cloud attestation endpoint (public) ──
section('10. Private AI: NEAR AI Cloud TEE attestation endpoint answers for the private model');
try {
  const nonce = crypto.randomBytes(32).toString('hex');
  const model = (priv[0]?.attestation.match(/^nearai-tee:([^:]+):/) || [])[1] || 'Qwen/Qwen3.8-27B';
  const r = await fetch(`https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(model)}&provider=near&include_tls_fingerprint=false&signing_algo=ecdsa&nonce=${nonce}`, { headers: { accept: 'application/json', 'x-no-aliasing': 'true' }, signal: AbortSignal.timeout(30_000) });
  const body = await r.text();
  const signer = (priv[0]?.attestation.match(/signer=(0x[0-9a-fA-F]+)/) || [])[1];
  ok(`attestation report available for ${model}`, r.ok, `HTTP ${r.status}, ${body.length} bytes`);
  if (signer) ok('enclave signer committed on-chain appears in the live attestation report', body.toLowerCase().includes(signer.toLowerCase()), `signer ${signer}`);
} catch (e) { ok('NEAR AI attestation endpoint reachable', false, e.message); }

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
