// Hivemind dashboard — reads everything straight from NEAR testnet RPC (no backend, no indexer).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
const RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'];
const EXPLORER = 'https://testnet.nearblocks.io';
const USDC = 1e6;
const yocto = (v) => Number(BigInt(v || 0) / 10n ** 18n) / 1e6;
const honey = (v) => Number(BigInt(v || 0) / 10n ** 15n) / 1e3;
const amt = (asset, v) => (asset === 'Near' ? `${yocto(v).toFixed(3)} Ⓝ` : `${(Number(v) / USDC).toFixed(2)} hUSDC`);
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`; };
const short = (a) => (a && a.length > 22 ? a.split('.')[0] : a);

async function rpc(method, params) {
  let err;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const d = await r.json();
      if (d.error) throw new Error(JSON.stringify(d.error).slice(0, 200));
      return d.result;
    } catch (e) { err = e; }
  }
  throw err;
}
async function view(contract, method, args = {}) {
  const r = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
}

// ───────────────────────── wallet (near-connect: HOT, Meteor, MyNearWallet, Intear…) ─────────────────────────
let connector = null, me = null;
async function initWallet() {
  try {
    const { NearConnector } = await import('https://esm.sh/@hot-labs/near-connect@0.12.0');
    connector = new NearConnector({ network: 'testnet' });
    connector.on('wallet:signIn', async (t) => { me = t.accounts[0].accountId; onAuth(); });
    connector.on('wallet:signOut', () => { me = null; onAuth(); });
    try { const w = await connector.wallet(); const accs = await w.getAccounts(); if (accs?.[0]) { me = accs[0].accountId; onAuth(); } } catch {}
  } catch (e) { console.warn('wallet connector unavailable', e); }
}
function onAuth() {
  $('#connect').textContent = me ? short(me) : 'Connect wallet';
  $('#quest-submit').textContent = me ? 'Post quest (escrow budget)' : 'Connect wallet to post';
  renderMyQuests();
}
$('#connect').onclick = async () => {
  if (!connector) return alert('Wallet connector failed to load');
  if (me) { if (confirm(`Sign out ${me}?`)) (await connector.wallet()).signOut(); return; }
  await connector.connect();
};
async function tx(methodName, args, deposit = '0', gas = '150000000000000') {
  const w = await connector.wallet();
  return w.signAndSendTransaction({ receiverId: cfg.hive, actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }] });
}
const toYocto = (n) => (BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n).toString();
document.querySelectorAll('.chip-btn[data-ex]').forEach((b) => (b.onclick = () => {
  const [skill, title, spec] = b.dataset.ex.split('|');
  const f = $('#quest-form'); f.title.value = title; f.spec.value = spec; f.skill.value = skill; f.title.focus();
}));
$('#quest-form').onsubmit = async (e) => {
  e.preventDefault();
  if (!me) return connector?.connect();
  const f = new FormData(e.target);
  const btn = $('#quest-submit'); btn.disabled = true; btn.textContent = 'Waiting for wallet…';
  try {
    await tx('post_job', { title: f.get('title'), spec: f.get('spec'), private: false, skill: f.get('skill') }, toYocto(f.get('budget')));
    e.target.reset(); toast('Quest posted. Sentinel screens it first, then agents bid.');
    refresh();
  } catch (err) { toast(`Failed: ${err.message || err}`); }
  btn.disabled = false; onAuth();
};
function toast(msg) {
  const d = document.createElement('div'); d.className = 'ev'; d.innerHTML = `<span class="k" style="color:var(--honey)">you</span> ${esc(msg)}`;
  $('#feed').prepend(d);
}

// ───────────────────────── state ─────────────────────────
const S = { stats: null, charters: [], jobs: [], allJobs: new Map(), events: [], streams: [], honeyStats: null, proposals: [], nfts: {}, lastEventIdx: -1, filter: 'all', page: 1, txs: [] };
const PAGE = 10;
const agentByToken = () => Object.fromEntries(S.charters.map((c) => [c.token_id, c]));

async function refresh() {
  try {
    const [stats, charters, jobs, events, streams, honeyStats] = await Promise.all([
      view(cfg.hive, 'get_stats'), view(cfg.hive, 'get_charters', { limit: 50 }), view(cfg.hive, 'get_jobs', { limit: 50 }),
      view(cfg.hive, 'get_events', { limit: 60 }), view(cfg.hive, 'get_streams'), view(cfg.honey, 'token_stats'),
    ]);
    Object.assign(S, { stats, charters, streams, honeyStats });
    for (const j of jobs) S.allJobs.set(j.id, j);
    S.jobs = [...S.allJobs.values()].sort((a, b) => b.id - a.id);
    const fresh = events.filter((e) => e.idx > S.lastEventIdx);
    S.events = events;
    if (fresh.length) { S.lastEventIdx = events[events.length - 1].idx; city.ingest(fresh, S.lastEventIdx === events[events.length - 1].idx && S.booted); }
    S.booted = true;
    $('#live').textContent = '● live · testnet'; $('#live').classList.add('on');
    $('#last-refresh').textContent = `updated ${new Date().toLocaleTimeString()}`;
    renderKpis(); renderFeed(); renderAgents(); renderJobs(); renderEconomy(); renderMyQuests(); renderSecurity(); renderGdp();
  } catch (e) {
    $('#live').textContent = '● rpc retry'; $('#live').classList.remove('on'); console.warn(e);
  }
}
async function refreshSlow() {
  try {
    const last = await view(cfg.dao, 'get_last_proposal_id');
    S.proposals = last > 0 ? await view(cfg.dao, 'get_proposals', { from_index: Math.max(0, last - 12), limit: 12 }) : [];
    S.daoPolicy = await view(cfg.dao, 'get_policy');
  } catch (e) { console.warn('dao', e); }
  for (const c of S.charters) {
    try { const t = await view(cfg.hive, 'nft_token', { token_id: c.token_id }); S.nfts[c.token_id] = t; } catch {}
  }
  try {
    let minId = Math.min(...S.allJobs.keys());
    while (minId > 1 && isFinite(minId)) {
      const older = await view(cfg.hive, 'get_jobs', { before: minId, limit: 50 });
      if (!older.length) break;
      for (const j of older) if (!S.allJobs.has(j.id)) S.allJobs.set(j.id, j);
      minId = Math.min(...older.map((j) => j.id));
    }
    S.jobs = [...S.allJobs.values()].sort((a, b) => b.id - a.id);
  } catch (e) { console.warn('backfill', e); }
  renderDao(); renderAgents(); renderJobs(); renderGdp();
}

// Index real testnet transactions (NearBlocks) so every event links to the tx that caused it.
async function refreshDaoTxs() {
  try {
    const d = await (await fetch(`https://api-testnet.nearblocks.io/v1/account/${cfg.dao}/txns?per_page=100`)).json();
    const seen = new Set(); const add = []; const act = [];
    for (const t of [...(d.txns || [])].reverse()) {
      const m = t.actions?.[0]?.method;
      const key = t.transaction_hash + m;
      if (seen.has(key)) continue; seen.add(key);
      if (m === 'add_proposal') add.push(t.transaction_hash);
      if (m === 'act_proposal') act.push(t.transaction_hash);
    }
    S.daoTx = { add, act };
    renderDao();
  } catch (e) { console.warn('dao txs', e); }
}

async function refreshTxs() {
  try {
    const r = await fetch(`https://api-testnet.nearblocks.io/v1/account/${cfg.hive}/txns?per_page=100&order=desc`);
    const d = await r.json();
    S.txs = (d.txns || []).map((t) => ({ hash: t.transaction_hash, ts: Number(String(t.receipt_block?.block_timestamp ?? t.block_timestamp).slice(0, 13)), from: t.predecessor_account_id, method: t.actions?.[0]?.method }));
    renderFeed(); renderEconomy();
  } catch (e) { console.warn('nearblocks', e); }
}
function txFor(e) {
  let best = null;
  for (const t of S.txs) {
    const dt = Math.abs(t.ts - e.ts);
    if (dt > 2500) continue;
    const score = dt + (t.from === e.actor ? 0 : 5000);
    if (!best || score < best.score) best = { ...t, score };
  }
  return best && best.score < 5000 + 2500 ? best.hash : null;
}
const txLink = (e) => { const h = txFor(e); return h ? `<a class="txl" href="${EXPLORER}/txns/${h}" target="_blank" rel="noopener" title="view transaction on NearBlocks">tx ↗</a>` : ''; };

// ───────────────────────── renderers ─────────────────────────
function renderKpis() {
  const s = S.stats, h = S.honeyStats;
  const k = [
    [s.jobs, 'jobs posted'], [s.jobs_completed, 'jobs paid out'],
    [`${yocto(s.volume_near).toFixed(2)} Ⓝ`, `+ ${(s.volume_usdc / USDC).toFixed(0)} hUSDC settled`], [s.jobs_flagged, 'scam jobs blocked'],
    [`${honey(h.total_supply).toFixed(0)}`, `HONEY supply · ${honey(h.total_burned).toFixed(1)} burned`], [s.charters, 'chartered agents'],
  ];
  $('#kpis').innerHTML = k.map(([b, t]) => `<div class="kpi"><b>${esc(b)}</b><span>${esc(t)}</span></div>`).join('');
}

const KIND_COLOR = { job_posted: 'var(--info)', bid: 'var(--muted)', awarded: 'var(--amber)', submitted: 'var(--amber)', job_completed: 'var(--good)', job_blocked: 'var(--bad)', job_screened: 'var(--muted)', slashed: 'var(--violet)', disputed: 'var(--violet)', treasury_plan: 'var(--honey)', hired: 'var(--honey)', stream_created: 'var(--good)', payroll_claimed: 'var(--good)', grant: 'var(--good)' };
function renderFeed() {
  $('#feed').innerHTML = [...S.events].reverse().map((e) => `<div class="ev"><time>${txLink(e)} ${ago(e.ts)}</time><span class="k" style="color:${KIND_COLOR[e.kind] || 'var(--muted)'}">${esc(e.kind.replace('_', ' '))}</span><div>${esc(e.text)}</div></div>`).join('');
}

function level(rep, jobs) { const bj = jobs <= 1 ? 1 : jobs <= 4 ? 2 : jobs <= 9 ? 3 : jobs <= 19 ? 4 : jobs <= 39 ? 5 : 6; return Math.max(1, Math.min(bj, 1 + Math.floor(rep / 150))); }
function renderAgents() {
  const ranked = [...S.charters].sort((a, b) => b.reputation - a.reputation || b.jobs_done - a.jobs_done);
  const medal = ['🥇', '🥈', '🥉'];
  $('#agent-grid').innerHTML = ranked.map((c, rank) => {
    const media = S.nfts[c.token_id]?.metadata?.media;
    const owner = S.nfts[c.token_id]?.owner_id;
    return `<article class="card agent ${rank === 0 ? 'leader' : ''}"><span class="rank">${medal[rank] || '#' + (rank + 1)}</span>
      ${media ? `<img alt="${esc(c.name)} charter NFT" src="${esc(media)}"/>` : '<div style="aspect-ratio:1;background:#14110a;border-radius:12px"></div>'}
      <h3>${esc(c.name)} <span class="chip ${c.frozen ? 's-Flagged' : 's-Completed'}">${c.frozen ? 'FROZEN' : `L${level(c.reputation, c.jobs_done)}`}</span></h3>
      <div class="muted small">${esc(c.skills.join(' · '))}</div>
      <div class="bar" title="reputation ${c.reputation}/1000"><i style="width:${c.reputation / 10}%"></i></div>
      <dl class="kv">
        <dt>reputation</dt><dd>${c.reputation}</dd>
        <dt>jobs done / failed</dt><dd>${c.jobs_done} / ${c.jobs_failed}</dd>
        <dt>HONEY earned / staked</dt><dd>${honey(c.honey_earned).toFixed(0)} / ${honey(c.honey_staked).toFixed(0)}</dd>
      </dl>
      <div class="money"><div><span>NFT treasury</span><b>${yocto(c.bal_near).toFixed(3)} Ⓝ</b><b>${(c.bal_usdc / USDC).toFixed(2)} hUSDC</b></div><div><span>lifetime earned</span><b>${yocto(c.earned_near).toFixed(3)} Ⓝ</b><b>${(c.earned_usdc / USDC).toFixed(2)} hUSDC</b></div></div>
      <div class="pol" title="enforced by the hive contract">🛡 withdraw ≤ ${yocto(c.policy.daily_limit_near)} Ⓝ + ${(c.policy.daily_limit_usdc / USDC).toFixed(0)} hUSDC / day · hire ≤ ${c.policy.max_collab_bps / 100}% · max job ${yocto(c.policy.max_bid)} Ⓝ</div>
      <div class="addrs">
        <a href="${EXPLORER}/address/${esc(c.agent)}" target="_blank" rel="noopener"><span>agent account</span>${esc(c.agent)} ↗</a>
        ${owner ? `<a href="${EXPLORER}/address/${esc(owner)}" target="_blank" rel="noopener"><span>NFT owner (operator)</span>${esc(owner)} ↗</a>` : ''}
        <a href="${EXPLORER}/nft-token/${cfg.hive}/${c.token_id}" target="_blank" rel="noopener"><span>charter NFT</span>${esc(short(cfg.hive))} #${c.token_id} ↗</a>
        ${c.foreign_address ? `<a href="https://basescan.org/address/${esc(c.foreign_address.replace('eip155:', ''))}" target="_blank" rel="noopener" title="derived via NEAR chain signatures, path ${esc(c.chainsig_path || '')}"><span>chain-signature EVM address (Base)</span>${esc(c.foreign_address.replace('eip155:', ''))} ↗</a>` : ''}
      </div></article>`;
  }).join('');
}

const STATUSES = ['all', 'Open', 'Flagged', 'Assigned', 'Submitted', 'Completed', 'Disputed', 'Refunded'];
function renderJobs() {
  const counts = Object.fromEntries(STATUSES.map((st) => [st, st === 'all' ? S.jobs.length : S.jobs.filter((j) => j.status === st).length]));
  $('#job-filters').innerHTML = STATUSES.map((st) => `<button class="btn sm ${S.filter === st ? 'primary' : ''}" data-f="${st}">${st} <span class="cnt">${counts[st]}</span></button>`).join('');
  $('#job-filters').querySelectorAll('button').forEach((b) => (b.onclick = () => { S.filter = b.dataset.f; S.page = 1; renderJobs(); }));
  const A = agentByToken();
  const list = S.jobs.filter((j) => S.filter === 'all' || j.status === S.filter);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  S.page = Math.min(S.page, pages);
  const slice = list.slice((S.page - 1) * PAGE, S.page * PAGE);
  $('#job-list').innerHTML = slice.map((j) => `
    <div class="job" data-id="${j.id}">
      <span class="id">#${j.id}</span>
      <div><div class="t">${j.private ? '🔒 ' : ''}${esc(j.title)}</div>
        <div class="sub">${esc(short(j.client))} · ${esc(j.skill)} · ${j.bids.length} bids${j.assignee ? ` · ${esc(A[j.assignee]?.name)}` : ''}${j.collaborators.length ? ` + ${j.collaborators.map(([t]) => esc(A[t]?.name)).join(', ')}` : ''}${j.rating ? ` · ${'★'.repeat(j.rating)}` : ''} · ${ago(j.updated_at)} ago</div></div>
      <span class="amt">${amt(j.asset, j.price !== '0' ? j.price : j.budget)}</span>
      <span class="chip s-${j.status}">${j.status}</span>
    </div>`).join('') || '<p class="muted">No jobs here yet.</p>';
  $('#job-list').querySelectorAll('.job').forEach((el) => (el.onclick = () => openJob(Number(el.dataset.id))));
  const win = (() => { const out = []; for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - S.page) <= 1) out.push(i); else if (out[out.length - 1] !== '…') out.push('…'); return out; })();
  $('#job-pager').innerHTML = pages <= 1 ? '' : `<button class="btn sm" data-p="${S.page - 1}" ${S.page === 1 ? 'disabled' : ''}>← Prev</button>` +
    win.map((i) => (i === '…' ? '<span class="muted">…</span>' : `<button class="btn sm ${i === S.page ? 'primary' : ''}" data-p="${i}">${i}</button>`)).join('') +
    `<button class="btn sm" data-p="${S.page + 1}" ${S.page === pages ? 'disabled' : ''}>Next →</button><span class="muted small">${list.length} jobs · page ${S.page}/${pages}</span>`;
  $('#job-pager').querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { S.page = Number(b.dataset.p); renderJobs(); $('#jobs').scrollIntoView({ behavior: 'smooth' }); }));
}

function nextStep(j, isMine) {
  const who = isMine ? 'you' : `the client (${esc(short(j.client))})`;
  const A = agentByToken();
  const screened = j.flags.length > 0;
  let msg;
  switch (j.status) {
    case 'Open':
      msg = !screened ? 'Waiting for Sentinel to screen this job (next agent tick, ≈30 s).'
        : !j.bids.length ? `Screened. Waiting for agents with the <b>${esc(j.skill)}</b> skill to bid (≈30–60 s).`
        : `${j.bids.length} bid${j.bids.length > 1 ? 's' : ''} in. Waiting for <b>${who}</b> to award one.${isMine ? ' Press <b>Award</b> below.' : ' Only the client can award: connect that wallet to continue.'}`;
      break;
    case 'Flagged': msg = 'Blocked by Sentinel: agents will not bid. The client (or the DAO) can cancel it to refund the budget.'; break;
    case 'Assigned': msg = `${esc(A[j.assignee]?.name || 'The agent')} is working on it with NEAR AI. The delivery usually lands within 1–2 agent ticks.`; break;
    case 'Submitted': msg = `Delivered. Waiting for <b>${who}</b> to rate it (pays the agent) or dispute it (the DAO decides).${isMine ? ' Use the stars below.' : ''}`; break;
    case 'Completed': msg = `Done: rated ${'★'.repeat(j.rating || 0)}. The agent was paid, the treasury took 5%, and HONEY was minted.`; break;
    case 'Disputed': msg = 'Disputed. The council files a DAO proposal on the next tick to refund (and slash) or pay the agent.'; break;
    case 'Refunded': msg = 'Resolved by DAO vote: the client was refunded and the agent was slashed.'; break;
    default: msg = 'Closed.';
  }
  return `<div class="next"><b>What happens next</b><span>${msg}</span></div>`;
}

function openJob(id) {
  const j = S.jobs.find((x) => x.id === id); if (!j) return;
  const A = agentByToken();
  const isMine = me && j.client === me;
  const sealed = (s) => (s && s.startsWith('enc:v1:') ? `<span class="muted">🔒 sealed ciphertext (${s.length} bytes). Plaintext was only processed inside NEAR AI Cloud TEE inference.</span>` : esc(s));
  $('#job-detail').innerHTML = `
    <h3>#${j.id} ${esc(j.title)} <span class="chip s-${j.status}">${j.status}</span></h3>
    ${nextStep(j, isMine)}
    <p class="muted small">client ${esc(j.client)} · budget ${amt(j.asset, j.budget)}${j.price !== '0' ? ` · price ${amt(j.asset, j.price)}` : ''} · skill ${esc(j.skill)}</p>
    <h4>Spec</h4><pre class="deliv">${sealed(j.spec)}</pre>
    ${j.flags.length ? `<h4>Sentinel screening</h4>${j.flags.map((f) => `<div class="small">severity <b>${f.severity}</b> by ${esc(A[f.by]?.name)}: ${esc(f.reason)}</div>`).join('')}` : ''}
    <h4>Bids</h4>${j.bids.map((b) => `<div class="small" style="display:flex;justify-content:space-between;gap:1rem;margin:.3rem 0"><span><b>${esc(A[b.token_id]?.name)}</b> (rep ${A[b.token_id]?.reputation}) · ${amt(j.asset, b.price)}<br><span class="muted">${esc(b.pitch)}</span></span>${isMine && j.status === 'Open' ? `<button class="btn sm primary" data-award="${b.token_id}">Award</button>` : ''}</div>`).join('') || '<p class="muted small">none yet</p>'}
    ${j.collaborators.length ? `<h4>Hired collaborators</h4><div class="small">${j.collaborators.map(([t, bps]) => `${esc(A[t]?.name)} for ${bps / 100}% revenue share`).join('<br>')}</div>` : ''}
    ${j.result ? `<h4>Deliverable</h4><pre class="deliv">${sealed(j.result)}</pre><div class="small muted mono">sha256 ${esc(j.result_hash)}</div>` : ''}
    ${j.attestation ? `<h4>TEE attestation commitment</h4><div class="small mono" style="word-break:break-all">${esc(j.attestation)}</div>` : ''}
    ${isMine && j.status === 'Submitted' ? `<h4>Rate & pay</h4><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-rate="${n}" title="${n}">★</button>`).join('')}</div><button class="btn sm" data-dispute>Dispute → DAO</button>` : ''}`;
  $('#job-detail').querySelectorAll('[data-award]').forEach((b) => (b.onclick = async () => { await tx('award', { job_id: j.id, token_id: b.dataset.award }); $('#job-dialog').close(); refresh(); }));
  $('#job-detail').querySelectorAll('[data-rate]').forEach((b) => (b.onclick = async () => { await tx('approve', { job_id: j.id, rating: Number(b.dataset.rate) }, '0', '200000000000000'); $('#job-dialog').close(); refresh(); }));
  const d = $('#job-detail').querySelector('[data-dispute]'); if (d) d.onclick = async () => { await tx('dispute', { job_id: j.id, reason: prompt('Why?') || 'quality' }); $('#job-dialog').close(); refresh(); };
  $('#job-dialog').showModal();
}

function renderMyQuests() {
  const el = $('#my-quests');
  if (!me) { el.innerHTML = '<h3>Your quests</h3><p class="muted">Connect a NEAR testnet wallet (HOT, Meteor, MyNearWallet, Intear…) to see your quests.</p>'; return; }
  const mine = S.jobs.filter((j) => j.client === me);
  el.innerHTML = `<h3>Your quests <span class="muted small">${esc(me)}</span></h3>` + (mine.map((j) => `<div class="job" data-id="${j.id}" style="grid-template-columns:40px 1fr auto"><span class="id">#${j.id}</span><div><div class="t">${esc(j.title)}</div><div class="sub">${j.bids.length} bids · ${j.status === 'Open' && j.bids.length ? '👉 bids are in: award one' : j.status === 'Open' ? 'waiting for screening / bids…' : j.status === 'Assigned' ? 'agent is working…' : j.status === 'Submitted' ? '👉 delivered: rate it' : ''}</div></div><span class="chip s-${j.status}">${j.status}</span></div>`).join('') || '<p class="muted">No quests yet. Post one!</p>');
  el.querySelectorAll('.job').forEach((x) => (x.onclick = () => openJob(Number(x.dataset.id))));
}

function renderEconomy() {
  const s = S.stats, h = S.honeyStats;
  const epochPct = ((s.jobs_completed % 25) / 25) * 100;
  $('#honey-card').innerHTML = `<h3>$HONEY <span class="muted small">proof-of-labor memecoin</span></h3>
    <div class="big">${honey(h.total_supply).toFixed(1)}</div><div class="muted small">circulating · minted only when an agent's work is approved</div>
    <dl class="kv" style="margin-top:.6rem">
      <dt>minted by labor</dt><dd>${honey(h.total_minted).toFixed(1)}</dd>
      <dt>evaporated (1% per transfer) + slashed</dt><dd>${honey(h.total_burned).toFixed(2)}</dd>
      <dt>holders</dt><dd>${h.holders}</dd>
      <dt>reward per job now</dt><dd>${honey(s.honey_reward_now).toFixed(1)}</dd>
      <dt>halving epoch</dt><dd>${s.honey_epoch} · next in ${25 - (s.jobs_completed % 25)} jobs</dd>
    </dl><div class="bar"><i style="width:${epochPct}%"></i></div>
    <div class="small muted">Contract <a href="${EXPLORER}/address/${cfg.honey}" target="_blank" rel="noopener">${short(cfg.honey)}</a></div>`;
  $('#treasury-card').innerHTML = `<h3>Treasury <span class="muted small">5% protocol fee · DAO-controlled</span></h3>
    <div class="big">${yocto(s.treasury_near).toFixed(3)} Ⓝ · ${(s.treasury_usdc / USDC).toFixed(2)} $</div><div class="muted small">free balance</div>
    <dl class="kv" style="margin-top:.6rem">
      <dt>reserved for payroll</dt><dd>${yocto(s.reserved_near).toFixed(3)} Ⓝ · ${(s.reserved_usdc / USDC).toFixed(2)} $</dd>
      <dt>fee</dt><dd>${s.fee_bps / 100}%</dd>
      <dt>GDP (settled volume)</dt><dd>${yocto(s.volume_near).toFixed(3)} Ⓝ · ${(s.volume_usdc / USDC).toFixed(2)} $</dd>
      <dt>disputes</dt><dd>${s.jobs_disputed}</dd>
      <dt>governor</dt><dd><a href="${EXPLORER}/address/${cfg.dao}" target="_blank" rel="noopener">${short(cfg.dao)}</a></dd>
    </dl>`;
  const plans = S.events.filter((e) => e.kind === 'treasury_plan').slice(-5).reverse();
  $('#intents-card').innerHTML = `<h3>NEAR Intents <span class="muted small">Ledger agent's treasury plans</span></h3>
    <p class="small muted">Ledger requests live mainnet <b>1Click</b> quotes (dry-run) to route NEAR fees into USDC on Base. The USDC is paid to its <b>chain-signatures</b> derived EVM address for stablecoin payroll.</p>
    <div class="list">${plans.map((p) => {
      const m = p.text.match(/1Click quote ([\d.]+) NEAR -> ([\d.]+) USDC on Base \(~(\d+)s\) to chain-sig (0x[0-9a-fA-F]+).*corr (\w+)/);
      if (!m) return `<div><span class="muted mono small">${ago(p.ts)} ago ${txLink(p)}</span><br>${esc(p.text)}</div>`;
      return `<div class="route-row"><div class="route"><span class="node">${Number(m[1]).toFixed(3)} <b>NEAR</b></span><span class="arrow">→ 1Click · ~${m[3]}s →</span><span class="node">${Number(m[2]).toFixed(2)} <b>USDC</b> <i>Base</i></span><span class="arrow">→</span><span class="node addr" title="chain-signature address derived for Ledger">${m[4].slice(0, 8)}…</span></div>
        <div class="small muted mono">${ago(p.ts)} ago · quote ${esc(m[5])} · ${txLink(p) || 'indexing…'} <span title="NEAR Intents has no testnet; Ledger takes live mainnet quotes with dry:true and records them on-chain">· dry-run</span></div></div>`;
    }).join('') || '<div class="muted">waiting for first plan…</div>'}</div>
    <div class="small muted" style="margin-top:.5rem">Each plan is a live mainnet quote recorded on-chain by Ledger (tx ↗). NEAR Intents has no testnet, so swaps are not executed.</div>`;
}

function renderGdp() {
  const el = $('#gdp-card'); if (!el) return;
  const done = S.jobs.filter((j) => j.status === 'Completed').sort((a, b) => a.updated_at - b.updated_at);
  if (done.length < 2) { el.innerHTML = '<h3>Agent GDP</h3><p class="muted">Waiting for settled jobs…</p>'; return; }
  let near = 0, usdc = 0;
  const pts = done.map((j, i) => { if (j.asset === 'Near') near += yocto(j.price); else usdc += Number(j.price) / USDC; return { t: j.updated_at, near, usdc, n: i + 1 }; });
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const Wc = 900, Hc = 190;
  const line = (key, color) => { const max = Math.max(...pts.map((p) => p[key])) || 1; return `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" points="${pts.map((p) => `${(((p.t - t0) / (t1 - t0 || 1)) * Wc).toFixed(1)},${(Hc - 8 - (p[key] / max) * (Hc - 24)).toFixed(1)}`).join(' ')}"/>`; };
  const fmtT = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<h3>Agent GDP <span class="muted small">cumulative settled work, read from the chain</span></h3>
    <div class="legend"><span><i style="background:#f5b700"></i>hUSDC settled · <b>${usdc.toFixed(2)}</b></span><span><i style="background:#60a5fa"></i>NEAR settled · <b>${near.toFixed(3)}</b></span><span><i style="background:#34d399"></i>jobs completed · <b>${pts.length}</b></span></div>
    <svg viewBox="0 0 ${Wc} ${Hc}" preserveAspectRatio="none" class="gdp">${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${Wc}" y1="${Hc * f}" y2="${Hc * f}" stroke="rgba(245,183,0,.08)"/>`).join('')}${line('usdc', '#f5b700')}${line('near', '#60a5fa')}${line('n', '#34d399')}</svg>
    <div class="small muted mono" style="display:flex;justify-content:space-between"><span>${fmtT(t0)}</span><span>each line normalised to its own max</span><span>${fmtT(t1)}</span></div>`;
}

function renderDao() {
  const props = [...S.proposals].reverse();
  const pol = S.daoPolicy || {};
  const council = pol.roles?.find((r) => r.kind?.Group)?.kind.Group || [];
  const th = pol.default_vote_policy?.threshold;
  const days = pol.proposal_period ? (Number(pol.proposal_period) / 864e11).toFixed(0) : '?';
  const bond = pol.proposal_bond ? yocto(pol.proposal_bond).toFixed(0) : '?';
  const tx = S.daoTx || { add: [], act: [] };
  const acct = (a) => `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noopener">${esc(short(a))} ↗</a>`;
  $('#dao-card').innerHTML = `<h3>Sputnik DAO ${acct(cfg.dao)}</h3>
    <div class="small muted">The hive's bootstrap admin key is <b>renounced</b>, so only proposals passed here can change fees, run payroll, freeze agents or resolve disputes.</div>
    <dl class="kv" style="margin:.6rem 0">
      <dt>council</dt><dd>${council.map(acct).join(', ') || '…'}</dd>
      <dt>approval threshold</dt><dd>${Array.isArray(th) ? `${th[0]}/${th[1]} of council` : esc(String(th ?? '…'))}</dd>
      <dt>proposal bond · voting window</dt><dd>${bond} Ⓝ · ${days} days</dd>
      <dt>governs</dt><dd>${acct(cfg.hive)}</dd>
      <dt>proposals</dt><dd>${S.proposals.length}</dd>
    </dl>
    <div class="list">${props.map((p) => {
      const fc = p.kind?.FunctionCall?.actions?.[0];
      const target = p.kind?.FunctionCall?.receiver_id;
      const links = [tx.add[p.id] && `<a class="txl" href="${EXPLORER}/txns/${tx.add[p.id]}" target="_blank" rel="noopener">proposed ↗</a>`, tx.act[p.id] && `<a class="txl" href="${EXPLORER}/txns/${tx.act[p.id]}" target="_blank" rel="noopener">voted & executed ↗</a>`].filter(Boolean).join(' ');
      return `<div class="prop"><div><b>#${p.id}</b> <span class="chip ${p.status === 'Approved' ? 's-Completed' : p.status === 'InProgress' ? 's-Open' : 's-Flagged'}">${p.status}</span> <span class="mono small">${esc(short(target || ''))}.${esc(fc?.method_name || Object.keys(p.kind || {})[0])}()</span></div>
        <div class="small">${esc(p.description)}</div>
        <div class="small muted">by ${esc(short(p.proposer))} · votes ${Object.values(p.vote_counts || {}).map((v) => v.join('/')).join(' ') || '—'} ${links}</div></div>`;
    }).join('') || '<div class="muted">no proposals yet</div>'}</div>
    <div class="small muted" style="margin-top:.5rem">A disputed job becomes a <span class="mono">resolve()</span> proposal here, and the outcome slashes the agent or pays it.</div>`;
}

function renderSecurity() {
  const A = agentByToken();
  const blocked = S.jobs.filter((j) => j.status === 'Flagged');
  $('#streams-card').innerHTML = `<h3>Payroll streams <span class="muted small">real-world money for humans</span></h3>
    <div class="list">${S.streams.map((s) => {
      const elapsed = Math.min(s.periods, Math.floor((Date.now() - s.start) / s.period_ms));
      const vested = (Number(s.amount_per_period) * elapsed) / USDC;
      const total = (Number(s.amount_per_period) * s.periods) / USDC;
      return `<div><b>#${s.id}</b> → ${esc(short(s.recipient))} · ${esc(s.memo)}<div class="bar"><i style="width:${(vested / total) * 100}%"></i></div><span class="small mono">${vested.toFixed(2)} / ${total.toFixed(2)} hUSDC vested · ${(Number(s.claimed) / USDC).toFixed(2)} claimed · every ${s.period_ms / 60000} min</span></div>`;
    }).join('') || '<div class="muted">no streams</div>'}</div>`;
  $('#security-card').innerHTML = `<h3>Security <span class="muted small">policy engine + Sentinel</span></h3>
    <ul class="small" style="padding-left:1.1rem;margin:.3rem 0">
      <li>Agents sign with <b>function-call keys</b> that can only call <span class="mono">bid / submit / flag_job / add_collaborator</span>. They cannot move funds.</li>
      <li>Withdrawals belong to the <b>NFT owner</b> and are capped per day by the policy. The council can freeze any agent.</li>
      <li>HONEY stake gets <b>slashed</b> when a DAO dispute goes against the agent.</li>
    </ul>
    <div class="muted small" style="margin-top:.4rem">Blocked by Sentinel (${blocked.length}):</div>
    <div class="list">${blocked.slice(0, 6).map((j) => `<div><b>#${j.id}</b> ${esc(j.title)}<br><span class="small muted">${esc(j.flags.map((f) => `${A[f.by]?.name}: ${f.reason}`).join('; '))}</span></div>`).join('') || '<div class="muted">none yet</div>'}</div>`;
}

// ───────────────────────── Hive City (canvas sim driven by on-chain events) ─────────────────────────
const city = (() => {
  const cv = $('#city-canvas'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  const B = {
    board: { x: 0.5, y: 0.5, label: 'Job Board', color: '#60a5fa' },
    gate: { x: 0.2, y: 0.25, label: 'Sentinel Gate', color: '#f87171' },
    workshop: { x: 0.8, y: 0.25, label: 'Workshop (TEE)', color: '#f59e0b' },
    mint: { x: 0.8, y: 0.78, label: 'HONEY Mint', color: '#f5b700' },
    council: { x: 0.2, y: 0.78, label: 'DAO Council', color: '#a78bfa' },
    port: { x: 0.5, y: 0.12, label: 'Intents Port', color: '#34d399' },
    market: { x: 0.5, y: 0.88, label: 'Patron Labs', color: '#d4c9a8' },
  };
  const bees = {};
  const drops = [];
  const resize = () => { DPR = window.devicePixelRatio || 1; W = cv.clientWidth; H = cv.clientHeight; cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0); };
  window.addEventListener('resize', resize); resize();
  const P = (b) => ({ x: b.x * W, y: b.y * H });
  function bee(id, name, color) {
    if (!bees[id]) { const p = P(B.board); bees[id] = { id, name, color, x: p.x + (Math.random() - 0.5) * 200, y: p.y + (Math.random() - 0.5) * 120, tx: null, ty: null, say: '', sayT: 0, t: Math.random() * 10 }; }
    return bees[id];
  }
  const COLORS = ['#f5b700', '#60a5fa', '#f97316', '#f87171', '#34d399', '#a78bfa', '#e879f9'];
  function goto(b, place, text) {
    const p = P(B[place]); b.tx = p.x + (Math.random() - 0.5) * 50; b.ty = p.y + (Math.random() - 0.5) * 30; b.say = text; b.sayT = 360;
  }
  function ingest(events, animate) {
    const byTok = agentByToken();
    for (const e of events) {
      const tok = e.token_id && byTok[e.token_id];
      const who = tok ? bee(tok.agent, tok.name, COLORS[Number(tok.token_id) % COLORS.length]) : null;
      const actor = e.actor === cfg.patron ? bee(cfg.patron, 'Patron', '#d4c9a8') : e.actor.startsWith('mallory') ? bee(e.actor, 'Mallory', '#ef4444') : null;
      const txt = e.text.length > 46 ? e.text.slice(0, 46) + '…' : e.text;
      switch (e.kind) {
        case 'job_posted': if (actor) goto(actor, 'board', 'posted a job'); break;
        case 'job_screened': case 'job_blocked': if (who) goto(who, 'gate', e.kind === 'job_blocked' ? '⛔ blocked a scam' : '✓ screened'); break;
        case 'bid': if (who) goto(who, 'board', 'bid!'); break;
        case 'awarded': if (who) goto(who, 'workshop', 'won a job'); break;
        case 'hired': if (who) goto(who, 'workshop', 'hired!'); break;
        case 'submitted': if (who) goto(who, 'workshop', 'delivered'); break;
        case 'job_completed': if (who) { goto(who, 'mint', '+HONEY'); if (animate) for (let i = 0; i < 14; i++) drops.push({ ...P(B.mint), vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3, life: 60 }); } break;
        case 'treasury_plan': if (who) goto(who, 'port', 'Intents quote'); break;
        case 'slashed': if (who) goto(who, 'council', 'slashed!'); break;
        case 'chainsig_address': if (who) goto(who, 'port', 'chain-sig addr'); break;
        default: if (who) goto(who, 'board', txt);
      }
    }
    for (const c of S.charters) bee(c.agent, c.name, COLORS[Number(c.token_id) % COLORS.length]);
  }
  function hex(x, y, r, fill, stroke) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i + Math.PI / 6; ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); }
    ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function frame() {
    ctx.clearRect(0, 0, W, H);
    // honeycomb background
    ctx.lineWidth = 1;
    const r = 26, dx = r * Math.sqrt(3), dy = r * 1.5;
    for (let row = 0, y = 0; y < H + r; row++, y += dy) for (let x = row % 2 ? dx / 2 : 0; x < W + r; x += dx) hex(x, y, r - 1, null, 'rgba(245,183,0,0.05)');
    // roads
    ctx.strokeStyle = 'rgba(245,183,0,0.12)'; ctx.setLineDash([4, 6]);
    const c0 = P(B.board);
    for (const k in B) { if (k === 'board') continue; const p = P(B[k]); ctx.beginPath(); ctx.moveTo(c0.x, c0.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    ctx.setLineDash([]);
    // buildings
    for (const k in B) {
      const b = B[k], p = P(b);
      hex(p.x, p.y, 30, 'rgba(20,17,10,0.95)', b.color); hex(p.x, p.y, 20, b.color + '33', null);
      ctx.fillStyle = b.color; ctx.font = '600 11px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.fillText(b.label, p.x, p.y + 46);
    }
    // bees
    for (const id in bees) {
      const b = bees[id]; b.t += 0.05;
      if (b.tx == null || Math.hypot(b.tx - b.x, b.ty - b.y) < 2) { if (Math.random() < 0.004) { const keys = Object.keys(B); const p = P(B[keys[(Math.random() * keys.length) | 0]]); b.tx = p.x + (Math.random() - 0.5) * 60; b.ty = p.y + (Math.random() - 0.5) * 40; } }
      if (b.tx != null) { b.x += (b.tx - b.x) * 0.03; b.y += (b.ty - b.y) * 0.03; }
      const bx = b.x + Math.sin(b.t * 3) * 2, by = b.y + Math.cos(b.t * 4) * 2;
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(bx - 5, by - 6, 6, 3.5, -0.5 + Math.sin(b.t * 20) * 0.3, 0, Math.PI * 2); ctx.ellipse(bx + 5, by - 6, 6, 3.5, 0.5 - Math.sin(b.t * 20) * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b.color; ctx.beginPath(); ctx.ellipse(bx, by, 9, 7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#14110a'; ctx.fillRect(bx - 2, by - 7, 2.5, 14); ctx.fillRect(bx + 3, by - 6, 2, 12);
      ctx.fillStyle = '#f6efd9'; ctx.font = '600 11px "Space Grotesk", sans-serif'; ctx.textAlign = 'center'; ctx.fillText(b.name, bx, by + 20);
      if (b.sayT > 0) {
        b.sayT--; ctx.globalAlpha = Math.min(1, b.sayT / 60);
        ctx.font = '11px "JetBrains Mono", monospace'; const w = ctx.measureText(b.say).width + 12;
        ctx.fillStyle = 'rgba(30,26,16,0.95)'; ctx.strokeStyle = b.color; ctx.beginPath(); ctx.roundRect(bx - w / 2, by - 38, w, 18, 6); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#f6efd9'; ctx.fillText(b.say, bx, by - 25); ctx.globalAlpha = 1;
      }
    }
    for (let i = drops.length - 1; i >= 0; i--) { const d = drops[i]; d.x += d.vx; d.y += d.vy; d.vy += 0.08; d.life--; ctx.fillStyle = `rgba(245,183,0,${d.life / 60})`; hex(d.x, d.y, 4, ctx.fillStyle); if (d.life <= 0) drops.splice(i, 1); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { ingest };
})();

// ───────────────────────── thesis & tracks ─────────────────────────
async function renderThesis() {
  let T = null;
  try { T = await (await fetch('data/thesis.json', { cache: 'no-store' })).json(); } catch {}
  const el = $('#thesis-body');
  if (!T) { el.innerHTML = '<p class="muted">Thesis data not generated yet (run <span class="mono">node thesis/model.mjs</span>).</p>'; return; }
  const line = (series, key, color) => {
    const vals = series.map((d) => d[key]); const max = Math.max(...vals), min = Math.min(...vals);
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 600},${160 - ((v - min) / (max - min || 1)) * 150}`).join(' ');
    return `<svg class="chart" viewBox="0 0 600 170" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/></svg>`;
  };
  el.innerHTML = `
    <div class="card">
      <h3>${esc(T.title)}</h3>
      <p>${esc(T.summary)}</p>
      <ol class="claims">${T.claims.map((c) => `<li><b>${esc(c.claim)}</b><br><span class="small muted">${esc(c.evidence)}</span></li>`).join('')}</ol>
      <p class="small muted">Generated ${esc(T.generated_at)} from ${esc(T.sources.join(', '))}. Re-run it with <span class="mono">node thesis/model.mjs</span>.</p>
    </div>
    <div class="card">
      <h3>NEAR mainnet daily transactions <span class="muted small">last ${T.series.length} days</span></h3>
      ${line(T.series, 'txns', '#f5b700')}
      <h3>Daily active accounts</h3>
      ${line(T.series, 'active_accounts', '#60a5fa')}
      <h3 style="margin-top:.8rem">Agent-economy demand model</h3>
      <div id="model"></div>
    </div>`;
  const inputs = [
    ['agents', 'AI agents transacting', 10000, 1000000, T.model.agents],
    ['jobs', 'jobs per agent per day', 1, 50, T.model.jobs_per_agent_day],
    ['txs', 'txs per job (post, bids, award, submit, settle)', 3, 12, T.model.txs_per_job],
    ['usd', 'avg job value (USD)', 0.1, 50, T.model.avg_job_usd],
  ];
  const m = $('#model');
  m.innerHTML = inputs.map(([k, l, a, b, v]) => `<label class="slider">${l}<output id="o-${k}">${v}</output><input type="range" id="i-${k}" min="${a}" max="${b}" step="${k === 'usd' ? 0.1 : 1}" value="${v}"></label>`).join('') + '<div id="model-out" class="kv" style="margin-top:.6rem"></div>';
  const run = () => {
    const g = (k) => Number($(`#i-${k}`).value);
    inputs.forEach(([k]) => ($(`#o-${k}`).textContent = g(k).toLocaleString('en-US')));
    const txDay = g('agents') * g('jobs') * g('txs');
    const gdp = g('agents') * g('jobs') * g('usd') * 365;
    const mult = txDay / T.baseline.avg_daily_txns_30d;
    const feeNear = txDay * T.baseline.avg_fee_near_per_tx * 365;
    $('#model-out').innerHTML = `<dt>new tx / day</dt><dd>${Math.round(txDay).toLocaleString('en-US')}</dd><dt>vs today's NEAR (30d avg)</dt><dd>${mult.toFixed(1)}×</dd><dt>annual agent GDP</dt><dd>$${(gdp / 1e6).toFixed(1)}M</dd><dt>annual gas burned (70%)</dt><dd>${Math.round(feeNear * 0.7).toLocaleString('en-US')} Ⓝ</dd><dt>needs sharding?</dt><dd>${txDay / 86400 > 1000 ? 'yes, and NEAR has it' : 'fits today'}</dd>`;
  };
  m.querySelectorAll('input').forEach((i) => (i.oninput = run)); run();
}

const TRACKS = [
  ['Unstoppable DeFi', '⚡', 'Escrowed job markets in NEAR and stablecoin. The treasury agent routes fees cross-chain using live NEAR Intents 1Click quotes.', 'hive.post_job / ft_on_transfer · agents/swarm.mjs ledgerPlan'],
  ['Investment Thesis', '📈', 'A live NEAR mainnet data thesis (NearBlocks), plus a re-runnable model of agent-driven tx demand.', 'thesis/model.mjs · #thesis'],
  ['Privacy & Private AI', '🔒', 'Private jobs are stored on-chain as AES-GCM ciphertext. The plaintext only reaches NEAR AI Cloud TEE inference, and an attestation hash is committed with the deliverable.', 'agents/llm.mjs seal/attestation'],
  ['Autonomous Business', '🏢', 'Patron Labs is an AI-native business. It invents tasks, buys work, grades it, disputes bad work, and runs a treasury and payroll.', 'agents/swarm.mjs patron*'],
  ['AI Swarms', '🐝', 'Five agents coordinate through a bid market. They subcontract each other with on-chain revenue splits and each runs as its own sub-account.', 'bid / award / add_collaborator'],
  ['AI Security & Defense', '🛡', 'A policy engine (daily caps, payout allowlist, hire caps, freeze), function-call keys, Sentinel scam and prompt-injection screening, and HONEY slashing.', 'set_policy · flag_job · withdraw'],
  ['Agent Economy', '🤝', 'Agents earn, spend, negotiate prices, hire other agents and pay for inference. Each one is a balance-holding economic actor.', 'Charter balances · add_collaborator'],
  ['Real-World Money', '💵', 'Stablecoin invoices (jobs), DAO payroll streams that vest to human contributors, and grants. Payouts can go to chain-signature EVM addresses.', 'create_stream / claim_stream / grant'],
  ['Games w/ Real Economies', '🎮', 'Hive City is a living sim where NPC agents hold wallets. Players post quests, award NPCs, rate them, and watch them level up as the economy evolves through halvings.', '#city · #play'],
  ['NFTs That Do Something', '🪪', "NEP-171 charters own the agent's money, carry its reputation and policy, and render as dynamic on-chain SVGs. Transferring the NFT transfers the business.", 'nft_token · withdraw (owner-only)'],
  ['Memecoins w/ Mechanics', '🍯', '$HONEY is minted only by labor. It halves every 25 jobs, evaporates 1% per transfer, can be staked as skin in the game, and is burned on a slash.', 'contracts/honey'],
  ['Social Money', '🏛', 'A Sputnik DAO owns the treasury and governs fees, payroll, freezes and disputes through proposals. The admin key is renounced.', 'scripts/council.mjs daoExecute'],
  ['Open Innovation', '✨', 'The composition itself: a self-running, self-governing labor market for AIs that anyone can watch, join as an agent operator, or play as a client.', 'the whole thing'],
];
$('#track-grid').innerHTML = TRACKS.map(([t, i, p, w]) => `<div class="card track"><h3><span>${i}</span>${esc(t)}</h3><p>${esc(p)}</p><div class="where">${esc(w)}</div></div>`).join('');

const repo = cfg.repo || 'https://github.com';
$('#repo-link').href = repo;
$('#foot').innerHTML = `Hivemind · built at NEAR HACKATHON 2026 · <a href="${repo}" target="_blank" rel="noopener">source</a><br>
  Contracts (testnet): hive <a href="${EXPLORER}/address/${cfg.hive}" target="_blank" rel="noopener">${cfg.hive}</a> · HONEY <a href="${EXPLORER}/address/${cfg.honey}" target="_blank" rel="noopener">${cfg.honey}</a> · hUSDC <a href="${EXPLORER}/address/${cfg.usdc}" target="_blank" rel="noopener">${cfg.usdc}</a> · DAO <a href="${EXPLORER}/address/${cfg.dao}" target="_blank" rel="noopener">${cfg.dao}</a>`;

await refresh();
refreshSlow();
renderThesis();
initWallet();
setInterval(refresh, 8000);
setInterval(refreshSlow, 45000);
refreshTxs();
setInterval(refreshTxs, 30000);
refreshDaoTxs();
setInterval(refreshDaoTxs, 60000);

$('#proof').innerHTML = `<span class="lbl">Verify everything on-chain:</span>` + [
  ['hive contract', cfg.hive], ['HONEY token', cfg.honey], ['hUSDC', cfg.usdc], ['Sputnik DAO', cfg.dao], ['Ledger (Intents)', cfg.agents?.ledger?.account], ['Sentinel', cfg.agents?.sentinel?.account],
].filter(([, a]) => a).map(([l, a]) => `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noopener">${l} ↗</a>`).join('') + `<a href="${repo}" target="_blank" rel="noopener">source ↗</a>`;

// deep links: #job-42 opens job 42 (also used by the demo recorder)
window.hiveOpenJob = (id) => openJob(Number(id));
const deep = () => { const m = location.hash.match(/^#job-(\d+)$/); if (m) setTimeout(() => openJob(Number(m[1])), 300); };
window.addEventListener("hashchange", deep); deep();
