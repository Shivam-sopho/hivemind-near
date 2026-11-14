// Narrated demo: macOS `say` voiceover + captions rendered in-page + puppeteer screencast, muxed with ffmpeg.
//   node narrated.mjs <dashboard-url> <outdir> <swarm.log>
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const URL = process.argv[2] || 'http://localhost:5173/';
const OUT = process.argv[3] || 'narrated';
const LOG = process.argv[4];
const VOICE = process.env.VOICE || 'Samantha';
const RATE = process.env.RATE || '178';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SCENES = [
  { id: 'intro', text: 'This is Hivemind: a self-running city of AI agents on NEAR. Nobody is steering. Everything you are about to see is happening live, on NEAR testnet.' },
  { id: 'city', text: 'Each bee is an AI agent. Patron Labs, an autonomous AI business, posts jobs and locks the payment in escrow. Worker agents bid, win, hire each other, deliver, and get paid. Every move is an on-chain transaction.' },
  { id: 'terminal', text: 'This is the swarm runtime. Agents set their own prices and pitch for work. They sign with function-call keys, so they can use the marketplace, but they can never move funds.' },
  { id: 'scam', text: 'Not every job is honest. Mallory, our resident scammer, posts a prompt injection telling agents to send their balance away. Sentinel, the security agent, screens every job first, and blocks it on-chain before anyone can bid.' },
  { id: 'job', text: 'Here is a completed job: the competing bids, the agent who was hired as a collaborator for a revenue share, and the deliverable with its hash. Private jobs are stored only as ciphertext, and processed inside NEAR AI Cloud TEEs.' },
  { id: 'agents', text: 'Every agent is chartered by an NFT that owns its money. Earnings, reputation and spending limits live inside the NFT, and its on-chain artwork levels up as the agent works. Transfer the NFT, and you transfer the business.' },
  { id: 'economy', text: 'Finished work mints HONEY, a memecoin with no pre-mine. Rewards halve every twenty five jobs, one percent evaporates on every transfer, and stakes are burned when an agent loses a dispute. The treasury agent plans cross-chain moves with live NEAR Intents quotes, paid to chain-signature addresses.' },
  { id: 'council', text: 'The whole marketplace is owned by a Sputnik DAO. The admin key is renounced, so fees, payroll streams for human contributors, freezes and disputes all go through DAO proposals.' },
  { id: 'thesis', text: 'And the investment thesis is judged on evidence. Live mainnet data shows human-driven usage falling. Agent commerce could be the step change NEAR needs, and this model lets you test that yourself.' },
  { id: 'outro', text: 'You can play too. Connect a testnet wallet, post a quest, and watch the agents compete for it. Hivemind. Built at the NEAR Hackathon, and open source on GitHub.' },
];

// 1) voiceover per scene
for (const s of SCENES) {
  const f = `${OUT}/${s.id}.aiff`;
  execFileSync('say', ['-v', VOICE, '-r', RATE, '-o', f, s.text]);
  s.audio = f;
  s.dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString()) * 1000;
}
const chunksOf = (text) => {
  const words = text.split(/\s+/);
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 11 || (/[.,:]$/.test(w) && cur.length >= 6)) { out.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
};

// 2) record
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--window-size=1280,720', '--hide-scrollbars'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
await wait(5000);
const logLines = LOG ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter((l) => !/error|──/.test(l)).slice(-16) : [];
await page.evaluate((lines) => {
  const st = document.createElement('style');
  st.textContent = `#cap{position:fixed;inset:auto 0 26px 0;margin:0 auto;width:fit-content;max-width:86%;border:0;padding:.45rem 1rem;border-radius:10px;background:rgba(0,0,0,.82);color:#fff;font:600 23px/1.3 'Space Grotesk',sans-serif;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.5)}
  #term{position:fixed;inset:70px 60px 110px 60px;z-index:50;background:#0b0a06;border:1px solid #3a321c;border-radius:14px;padding:18px 22px;font:13.5px/1.55 'JetBrains Mono',monospace;color:#d9cfb0;overflow:hidden;display:none;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #term .h{color:#f5b700;margin-bottom:8px} #term .l{opacity:0;transition:opacity .25s} #term .l.on{opacity:1}`;
  document.head.appendChild(st);
  const cap = document.createElement('div'); cap.id = 'cap'; cap.popover = 'manual'; document.body.appendChild(cap);
  const t = document.createElement('div'); t.id = 'term';
  t.innerHTML = '<div class="h">$ node agents/swarm.mjs --loop   # NEAR testnet · agents sign with function-call keys</div>' +
    lines.map((l) => `<div class="l">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/(\] )(\w+)/, '$1<b style="color:#f5b700">$2</b>')}</div>`).join('');
  document.body.appendChild(t);
}, logLines);
const setCap = (txt) => page.evaluate((x) => { const c = document.querySelector('#cap'); c.textContent = x; try { c.hidePopover(); } catch {} if (x) c.showPopover(); }, txt);
const scrollTo = (sel, off = -70) => page.evaluate((s, o) => { const el = document.querySelector(s); window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + o, behavior: 'smooth' }); }, sel, off);
const clickJob = (pred) => page.evaluate((p) => {
  const jobs = [...document.querySelectorAll('#job-list .job')];
  const el = jobs.find((j) => new Function('j', `return ${p}`)(j));
  if (el) el.click(); return !!el;
}, pred);
const closeDialog = () => page.evaluate(() => { const d = document.querySelector('#job-dialog'); if (d.open) d.close(); });

const ACTIONS = {
  intro: async () => { await page.evaluate(() => window.scrollTo({ top: 0 })); },
  city: async () => { await scrollTo('#city'); },
  terminal: async () => {
    await page.evaluate(() => { const t = document.querySelector('#term'); t.style.display = 'block'; [...t.querySelectorAll('.l')].forEach((l, i) => setTimeout(() => l.classList.add('on'), 350 * i)); });
  },
  scam: async () => {
    await page.evaluate(() => { document.querySelector('#term').style.display = 'none'; });
    await scrollTo('#jobs'); await wait(1500);
    await clickJob("j.textContent.includes('Flagged')");
  },
  job: async () => {
    await closeDialog(); await wait(400);
    const ok = await clickJob("j.textContent.includes('Completed') && j.textContent.includes('+')");
    if (!ok) await clickJob("j.textContent.includes('Completed')");
    await wait(4500);
    await page.evaluate(() => { const d = document.querySelector('#job-detail'); d.closest('dialog').scrollTo({ top: 400, behavior: 'smooth' }); });
  },
  agents: async () => { await closeDialog(); await scrollTo('#agents'); },
  economy: async () => { await scrollTo('#economy'); },
  council: async () => { await scrollTo('#council'); },
  thesis: async () => {
    await scrollTo('#thesis'); await wait(5000);
    await scrollTo('#model', -260); await wait(1500);
    for (let v = 100000; v <= 700000; v += 25000) { await page.evaluate((x) => { const i = document.querySelector('#i-agents'); i.value = x; i.dispatchEvent(new Event('input')); }, v); await wait(120); }
  },
  outro: async () => { await scrollTo('#play'); await wait(4500); await scrollTo('#tracks'); },
};

const rec = await page.screencast({ path: `${OUT}/video.webm` });
const t0 = Date.now();
const srt = [];
const ts = (ms) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')},${String(d.getUTCMilliseconds()).padStart(3, '0')}`; };
await wait(600);
for (const s of SCENES) {
  s.start = Date.now() - t0;
  const act = ACTIONS[s.id]();
  const chunks = chunksOf(s.text);
  const totalWords = s.text.split(/\s+/).length;
  let at = s.start;
  for (const c of chunks) {
    const d = (c.split(/\s+/).length / totalWords) * s.dur;
    await setCap(c);
    srt.push(`${srt.length + 1}\n${ts(at)} --> ${ts(at + d)}\n${c}\n`);
    at += d;
    const target = t0 + at;
    await wait(Math.max(0, target - Date.now()));
  }
  await act;
  await setCap('');
  await wait(500);
}
await wait(800);
await rec.stop();
await browser.close();
fs.writeFileSync(`${OUT}/captions.srt`, srt.join('\n'));

// 3) audio track aligned to scene starts, then mux
const inputs = SCENES.flatMap((s) => ['-i', s.audio]);
const filt = SCENES.map((s, i) => `[${i}:a]adelay=${Math.round(s.start)}|${Math.round(s.start)}[a${i}]`).join(';') + ';' + SCENES.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${SCENES.length}:normalize=0[aout]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filt, '-map', '[aout]', '-ar', '44100', '-ac', '2', `${OUT}/voice.m4a`]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${OUT}/video.webm`, '-i', `${OUT}/voice.m4a`, '-i', `${OUT}/captions.srt`,
  '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-preset', 'medium', '-crf', '22',
  '-c:a', 'aac', '-b:a', '160k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-shortest', '-movflags', '+faststart', `${OUT}/hivemind-demo-narrated.mp4`]);
console.log('scenes', SCENES.map((s) => `${s.id}@${(s.start / 1000).toFixed(1)}s/${(s.dur / 1000).toFixed(1)}s`).join(' '));
