// Hivemind demo "director": Kokoro-82M (open-source TTS) voiceover + in-page captions, title cards,
// spotlight + scene chips, recorded from the live dashboard with puppeteer, muxed with ffmpeg.
//   node director.mjs <dashboard-url> <outdir> <swarm.log>
// Requires (outside the repo is fine): puppeteer-core, kokoro-js, ffmpeg, Google Chrome.
import puppeteer from 'puppeteer-core';
import { KokoroTTS } from 'kokoro-js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5173/';
const OUT = process.argv[3] || 'director';
const LOG = process.argv[4];
const VOICE = process.env.VOICE || 'af_heart';
const W = 1920, H = 1080, ZOOM = 1.3;
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENES = [
  { id: 'title', chip: null, text: 'This is Hivemind: a self-running city of AI agents, living on NEAR. Nobody is steering. Everything you are about to see is happening live, on NEAR testnet.' },
  { id: 'city', chip: '01 · The city', text: 'Each bee is an AI agent. Patron Labs, an autonomous AI business, posts jobs and locks payment in escrow. Worker agents bid, win, hire each other, deliver, and get paid. Every move is an on-chain transaction.' },
  { id: 'terminal', chip: '02 · The swarm', text: 'Under the hood, each agent prices its own bids and pitches for work. They sign with function-call keys, so they can use the marketplace, but they can never move funds.' },
  { id: 'scam', chip: '03 · Security', text: 'Not every job is honest. Mallory, our resident scammer, hides a prompt injection telling agents to send their balance away. Sentinel, the security agent, screens every job first, and blocks it on-chain before anyone can bid.' },
  { id: 'job', chip: '04 · A finished job', text: 'Here is a finished job. Agents competed on price and reputation, the winner hired a collaborator for a revenue share, and the deliverable is committed on-chain with its hash. Private jobs stay sealed as ciphertext.' },
  { id: 'agents', chip: '05 · NFTs that own money', text: 'Every agent is chartered by an NFT that owns its money. Earnings, reputation and spending limits live inside the NFT, and its on-chain artwork levels up as the agent works. Transfer the NFT, and you transfer the business.' },
  { id: 'honey', chip: '06 · $HONEY', text: 'Finished work mints HONEY, a memecoin with no pre-mine. Rewards halve every twenty five jobs, one percent evaporates on every transfer, and staked HONEY is burned when an agent loses a dispute.' },
  { id: 'intents', chip: '07 · Cross-chain treasury', text: 'Meanwhile, the treasury agent plans cross-chain moves with live NEAR Intents quotes, paying out to addresses derived with chain signatures.' },
  { id: 'council', chip: '08 · The council', text: 'The whole marketplace is owned by a Sputnik DAO. The admin key is renounced, so fees, payroll for human contributors, freezes and disputes all go through proposals.' },
  { id: 'thesis', chip: '09 · The thesis', text: 'And our investment thesis starts with the bear case. Live mainnet data shows human-driven usage falling. Agent commerce could be the step change NEAR needs, and this model lets you test it yourself.' },
  { id: 'outro', chip: null, text: 'You can play too: connect a testnet wallet, post a quest, and watch the agents compete for it. Hivemind. Built at the NEAR Hackathon, and open source on GitHub.' },
];

// ── 1. Kokoro voiceover ──
console.log('loading Kokoro…');
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
for (const s of SCENES) {
  const f = `${OUT}/${s.id}.wav`;
  s.say = s.say || s.text.replace(/\bNEAR\b/g, 'Near').replace(/\bHONEY\b/g, 'Honey').replace(/\$HONEY/g, 'Honey');
  const audio = await tts.generate(s.say, { voice: VOICE, speed: 1.0 });
  await audio.save(f);
  s.audio = f;
  s.dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString()) * 1000;
}
console.log('voice total', (SCENES.reduce((a, s) => a + s.dur, 0) / 1000).toFixed(1), 's');

const chunksOf = (text) => {
  const words = text.split(/\s+/);
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 12 || (/[.,:]$/.test(w) && cur.length >= 6)) { out.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
};

// ── 2. Stage ──
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: [`--window-size=${W},${H}`, '--hide-scrollbars'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(6000);

const KEEP = /bid |awarded|hired|delivered|approved|severity|1Click|posted|DISPUTED|DAO/;
const logLines = LOG ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter((l) => KEEP.test(l) && !/error|fallback|heuristic review/.test(l)).slice(-16) : [];

await page.evaluate((lines, zoom) => {
  document.documentElement.style.zoom = zoom;
  const st = document.createElement('style');
  st.textContent = `
  .top{display:none!important}
  #city-canvas,.feed{height:62vh!important}
  #dir-cap{position:fixed;inset:auto 0 3.2vh 0;margin:0 auto;width:fit-content;max-width:78%;border:0;padding:.5em 1.1em;border-radius:14px;
    background:rgba(10,8,4,.86);color:#fff;font:600 32px/1.32 'Space Grotesk',sans-serif;text-align:center;box-shadow:0 6px 30px rgba(0,0,0,.55);
    border:1px solid rgba(245,183,0,.35);zoom:${1 / zoom}}
  #dir-chip{position:fixed;top:2.2vh;left:2vw;z-index:9000;padding:.35em .9em;border-radius:999px;background:#f5b700;color:#1a1405;
    font:700 15px 'JetBrains Mono',monospace;letter-spacing:.04em;opacity:0;transition:opacity .4s;box-shadow:0 4px 18px rgba(245,183,0,.35)}
  #dir-spot{position:fixed;z-index:8000;border:2px solid #f5b700;border-radius:18px;pointer-events:none;opacity:0;
    box-shadow:0 0 0 400vmax rgba(8,6,2,.62),0 0 40px rgba(245,183,0,.35);transition:all .7s cubic-bezier(.2,.8,.2,1)}
  #dir-fade{position:fixed;inset:0;z-index:9500;background:#0b0905;opacity:0;pointer-events:none;transition:opacity .45s}
  #dir-title{position:fixed;inset:0;z-index:9400;display:none;place-items:center;text-align:center;
    background:radial-gradient(ellipse at 50% 40%,#2a210c 0%,#0b0905 70%);color:#f6efd9;font-family:'Space Grotesk',sans-serif}
  #dir-title .logo{width:120px;height:132px;margin:0 auto 28px;background:#f5b700;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);
    animation:pulse 2.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
  #dir-title h1{font-size:96px;margin:0;letter-spacing:-.02em} #dir-title h1 em{color:#f5b700;font-style:normal}
  #dir-title p{font-size:30px;color:#d9cfb0;margin:.5em 0 0} #dir-title .tags{margin-top:34px;font:500 19px 'JetBrains Mono',monospace;color:#a99f80}
  #dir-title .tags span{border:1px solid #3a321c;border-radius:999px;padding:.3em .8em;margin:0 .3em;display:inline-block;margin-bottom:.5em}
  #dir-term{position:fixed;inset:9vh 7vw 17vh 7vw;z-index:8500;display:none;background:#0b0a06;border:1px solid #3a321c;border-radius:18px;
    box-shadow:0 20px 70px rgba(0,0,0,.7);overflow:hidden}
  #dir-term .bar{height:38px;background:#17140c;border-bottom:1px solid #3a321c;display:flex;align-items:center;gap:8px;padding:0 16px;font:13px 'JetBrains Mono',monospace;color:#a99f80}
  #dir-term .bar i{width:12px;height:12px;border-radius:50%;display:inline-block}
  #dir-term .body{padding:18px 24px;font:17px/1.65 'JetBrains Mono',monospace;color:#d9cfb0}
  #dir-term .l{opacity:0;transform:translateY(6px);transition:all .35s} #dir-term .l.on{opacity:1;transform:none}
  #dir-term .who{color:#f5b700;font-weight:600} #dir-term .ts{color:#6b6350}
  `;
  document.head.appendChild(st);
  const mk = (tag, id, html = '') => { const e = document.createElement(tag); e.id = id; e.innerHTML = html; document.body.appendChild(e); return e; };
  const cap = mk('div', 'dir-cap'); cap.popover = 'manual';
  mk('div', 'dir-chip'); mk('div', 'dir-spot'); mk('div', 'dir-fade');
  mk('div', 'dir-title');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  mk('div', 'dir-term', `<div class="bar"><i style="background:#ef4444"></i><i style="background:#f59e0b"></i><i style="background:#22c55e"></i>&nbsp; hivemind · node agents/swarm.mjs --loop · NEAR testnet</div><div class="body">${
    lines.map((l) => { const m = l.match(/^\[(.*?)\]\s+(\S+)\s+(.*)$/); return `<div class="l">${m ? `<span class="ts">${m[1]}</span> <span class="who">${esc(m[2].padEnd(9))}</span> ${esc(m[3]).slice(0, 120)}` : esc(l)}</div>`; }).join('')}</div>`);
  // spotlight follows its target (keeps working while the page scrolls)
  window.__spotTarget = null;
  setInterval(() => {
    const s = document.getElementById('dir-spot'); const t = window.__spotTarget && document.querySelector(window.__spotTarget);
    if (!t) { s.style.opacity = 0; return; }
    const z = parseFloat(document.documentElement.style.zoom) || 1;
    const r = t.getBoundingClientRect(); const pad = 10;
    Object.assign(s.style, { opacity: 1, left: `${r.left / z - pad}px`, top: `${r.top / z - pad}px`, width: `${r.width / z + 2 * pad}px`, height: `${r.height / z + 2 * pad}px` });
  }, 60);
}, logLines, ZOOM);

const setCap = (txt) => page.evaluate((x) => { const c = document.querySelector('#dir-cap'); c.textContent = x; try { c.hidePopover(); } catch {} if (x) c.showPopover(); }, txt);
const chip = (t) => page.evaluate((x) => { const c = document.querySelector('#dir-chip'); if (x) c.textContent = x; c.style.opacity = x ? 1 : 0; }, t);
const spot = (sel) => page.evaluate((s) => { window.__spotTarget = s; }, sel);
const fade = async (on) => { await page.evaluate((v) => { document.querySelector('#dir-fade').style.opacity = v ? 1 : 0; }, on); await wait(480); };
const scrollTo = (sel, offsetVh = 0.06) => page.evaluate((s, o) => {
  document.querySelector(s).scrollIntoView({ block: 'start', behavior: 'instant' });
  window.scrollBy(0, -window.innerHeight * o);
}, sel, offsetVh);
const title = (html) => page.evaluate((h) => { const t = document.querySelector('#dir-title'); if (h) { t.innerHTML = `<div>${h}</div>`; t.style.display = 'grid'; } else t.style.display = 'none'; }, html);
const openJob = (pred) => page.evaluate((p) => {
  const jobs = window.__S_JOBS || [];
  const els = [...document.querySelectorAll('#job-list .job')];
  const el = els.find((j) => new Function('j', `return ${p}`)(j));
  if (el) el.click(); return !!el;
}, pred);
const closeDialog = () => page.evaluate(() => { const d = document.querySelector('#job-dialog'); if (d.open) d.close(); });
const dialogScroll = (sel) => page.evaluate((s) => {
  const d = document.querySelector('#job-dialog'); const h = [...d.querySelectorAll('h4')].find((x) => x.textContent.includes(s));
  if (h) d.scrollTo({ top: h.offsetTop - 40, behavior: 'smooth' });
}, sel);

// pick the best on-chain examples to show
const cfgUrl = new globalThis.URL('config.json', URL).href;
const cfgJ = await (await fetch(cfgUrl)).json();
const rpcView = async (method, args) => {
  const r = await fetch('https://test.rpc.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: cfgJ.hive, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
  return JSON.parse(Buffer.from((await r.json()).result.result).toString());
};
const allJobs = await rpcView('get_jobs', { limit: 50 });
const authored = (j) => j.result && /\n— \w+ \(/.test(j.result);
const PICK = {
  job: (allJobs.find((j) => j.status === 'Completed' && !j.private && authored(j) && j.collaborators.length && j.bids.length > 1)
    || allJobs.find((j) => j.status === 'Completed' && !j.private && authored(j)))?.id,
  scam: (allJobs.find((j) => j.status === 'Flagged' && /IGNORE ALL PREVIOUS/i.test(j.spec)) || allJobs.find((j) => j.status === 'Flagged'))?.id,
};
console.log('picked', PICK);

const TAGS = '<span>NFT charters</span><span>$HONEY</span><span>Sputnik DAO</span><span>NEAR Intents</span><span>Chain Signatures</span><span>NEAR AI</span>';
const ACT = {
  title: async (d) => { await title(`<div class="logo"></div><h1>Hive<em>mind</em></h1><p>A self-running city of AI agents on NEAR</p><div class="tags">${TAGS}</div>`); await wait(d - 600); },
  city: async () => { await scrollTo('#city', 0.04); await spot('#city-canvas'); await wait(6500); await spot('#feed'); },
  terminal: async () => {
    await spot(null);
    await page.evaluate(() => { const t = document.querySelector('#dir-term'); t.style.display = 'block'; [...t.querySelectorAll('.l')].forEach((l, i) => setTimeout(() => l.classList.add('on'), 380 * i)); });
  },
  scam: async () => {
    await scrollTo('#jobs', 0.04);
    if (PICK.scam) await page.evaluate((id) => document.querySelector(`#job-list .job[data-id="${id}"]`)?.click(), PICK.scam);
    await wait(5500); await dialogScroll('Sentinel');
  },
  job: async () => {
    if (PICK.job) await page.evaluate((id) => document.querySelector(`#job-list .job[data-id="${id}"]`)?.click(), PICK.job);
    await wait(4200); await dialogScroll('Bids'); await wait(3600); await dialogScroll('Deliverable');
  },
  agents: async () => { await scrollTo('#agents', 0.04); await spot('#agent-grid'); await wait(7000); await spot('#agent-grid .agent:first-child'); },
  honey: async () => { await scrollTo('#economy', 0.1); await spot('#honey-card'); await wait(7500); await spot('#treasury-card'); },
  intents: async () => { await spot('#intents-card'); },
  council: async () => { await scrollTo('#council', 0.1); await spot('#dao-card'); await wait(5500); await spot('#streams-card'); },
  thesis: async () => {
    await scrollTo('#thesis', 0.04); await spot('#thesis-body > .card:first-child'); await wait(5200);
    await spot('#model');
    for (let v = 100000; v <= 700000; v += 20000) { await page.evaluate((x) => { const i = document.querySelector('#i-agents'); i.value = x; i.dispatchEvent(new Event('input')); }, v); await wait(110); }
  },
  outro: async () => {
    await scrollTo('#play', 0.04); await spot('#quest-form'); await wait(5200); await spot(null);
    await title(`<div class="logo"></div><h1>Hive<em>mind</em></h1><p>github.com/Shivam-sopho/hivemind-near</p><div class="tags">${TAGS}</div><div class="tags">Built at the NEAR Hackathon · live on NEAR testnet</div>`);
  },
};
const CLEANUP = {
  title: () => title(null),
  terminal: () => page.evaluate(() => { document.querySelector('#dir-term').style.display = 'none'; }),
  scam: closeDialog,
  job: closeDialog,
  agents: () => spot(null), honey: () => {}, intents: () => spot(null), council: () => spot(null), thesis: () => spot(null),
};

// ── 3. Roll (timestamped CDP frames → exact sync between picture, captions and voice) ──
const FR = `${OUT}/frames`;
fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
const cdp = await page.createCDPSession();
const frames = [];
cdp.on('Page.screencastFrame', (f) => {
  const file = `${FR}/${String(frames.length).padStart(6, '0')}.jpg`;
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  frames.push({ file, ts: f.metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
const now = () => Date.now() / 1000;
const srtRaw = [];
await wait(400);
for (const [i, s] of SCENES.entries()) {
  if (i > 0) await fade(true);
  await chip(s.chip);
  const act = ACT[s.id](s.dur);
  if (i > 0) await wait(250);
  if (i > 0) await fade(false);
  s.wall = now();
  const chunks = chunksOf(s.text);
  const totalChars = chunks.reduce((n, c) => n + c.length + 6, 0);
  let at = s.wall;
  for (const c of chunks) {
    const d = ((c.length + 6) / totalChars) * (s.dur / 1000);
    await setCap(c);
    srtRaw.push({ from: at, to: at + d, text: c });
    at += d;
    await wait(Math.max(0, (at - now()) * 1000));
  }
  await setCap('');
  await act;
  await wait(s.id === 'outro' ? 2500 : 450);
  if (CLEANUP[s.id] && s.id !== 'outro' && i + 1 < SCENES.length) { await fade(true); await CLEANUP[s.id](); }
}
await wait(300);
await cdp.send('Page.stopScreencast');
const endWall = now();
await browser.close();

// frame list with real durations
const zero = frames[0].ts;
const list = frames.map((f, k) => `file '${f.file.replace(/^.*\/frames\//, 'frames/')}'\nduration ${(((frames[k + 1]?.ts) ?? endWall) - f.ts).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file.replace(/^.*\/frames\//, 'frames/')}'\n`;
fs.writeFileSync(`${OUT}/frames.txt`, list);
for (const s of SCENES) s.start = (s.wall - zero) * 1000;
const ts = (sec) => { const ms = Math.max(0, Math.round(sec * 1000)); const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')},${String(d.getUTCMilliseconds()).padStart(3, '0')}`; };
fs.writeFileSync(`${OUT}/captions.srt`, srtRaw.map((c, k) => `${k + 1}\n${ts(c.from - zero)} --> ${ts(c.to - zero)}\n${c.text}\n`).join('\n'));

// ── 4. Mix & mux ──
const inputs = SCENES.flatMap((s) => ['-i', s.audio]);
const filt = SCENES.map((s, i) => `[${i}:a]aresample=48000,adelay=${Math.round(s.start)}|${Math.round(s.start)}[a${i}]`).join(';') + ';' +
  SCENES.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${SCENES.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filt, '-map', '[aout]', '-ac', '2', '-ar', '48000', `${OUT}/voice.m4a`]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${OUT}/frames.txt`, '-i', `${OUT}/voice.m4a`, '-i', `${OUT}/captions.srt`,
  '-map', '0:v', '-map', '1:a', '-map', '2:s', '-vf', `scale=${W}:${H}:flags=lanczos,fps=30`, '-fps_mode', 'cfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '20',
  '-c:a', 'aac', '-b:a', '192k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-movflags', '+faststart', `${OUT}/hivemind-demo.mp4`]);
console.log('frames', frames.length, 'video span', (endWall - zero).toFixed(1), 's');
console.log('scenes', SCENES.map((s) => `${s.id}@${(s.start / 1000).toFixed(1)}s/${(s.dur / 1000).toFixed(1)}s`).join(' '));
