// NEAR AI Cloud client (OpenAI-compatible). Private jobs run on open-weight models served inside
// GPU TEEs; we fetch the enclave attestation report and commit its hash on-chain with the deliverable.
import crypto from 'node:crypto';

const BASE = process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1';
export const MODEL = process.env.HIVE_MODEL || 'deepseek/deepseek-v4.1-flash';
export const PRIVATE_MODEL = process.env.HIVE_PRIVATE_MODEL || 'Qwen/Qwen3.8-27B';
export const hasKey = () => Boolean(process.env.NEARAI_API_KEY);

// ── Spend guard ──
// Real cost is computed from the token usage NEAR AI returns x the per-token prices from /v1/models.
// Background activity (the patron's own jobs, screening/bidding on them) stops using the LLM once the
// daily cap is reached and falls back to the authored library; work for real users' quests ("high"
// priority) keeps using NEAR AI until the hard total cap, so judges always get live AI.
import fs from 'node:fs';
const USAGE_FILE = process.env.HIVE_USAGE_FILE || '.keys/llm-usage.json';
const DAILY_USD = Number(process.env.HIVE_LLM_DAILY_USD || 1.5);
const TOTAL_USD = Number(process.env.HIVE_LLM_TOTAL_USD || 9);
let PRICES = null;
const today = () => new Date().toISOString().slice(0, 10);
function readUsage() {
  try { const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); if (u.day !== today()) { u.day = today(); u.spentDay = 0; } return u; } catch { return { day: today(), spentDay: 0, spentTotal: 0, calls: 0 }; }
}
function addUsage(usd) {
  const u = readUsage(); u.spentDay += usd; u.spentTotal += usd; u.calls = (u.calls || 0) + 1;
  try { fs.mkdirSync(USAGE_FILE.replace(/\/[^/]+$/, ''), { recursive: true }); fs.writeFileSync(USAGE_FILE, JSON.stringify(u)); } catch {}
}
export function spend() { return readUsage(); }
export function llmAllowed(priority = 'normal') {
  if (!hasKey()) return false;
  const u = readUsage();
  if (u.spentTotal >= TOTAL_USD) return false;
  return priority === 'high' || u.spentDay < DAILY_USD;
}
async function prices() {
  if (PRICES) return PRICES;
  try { PRICES = Object.fromEntries((await (await fetch(`${BASE}/models`)).json()).data.map((m) => [m.id, m.pricing])); } catch { PRICES = {}; }
  return PRICES;
}

export async function chat(messages, { model = MODEL, maxTokens = 700, json = false, temperature = 0.7, priority = 'normal' } = {}) {
  if (!llmAllowed(priority)) return null;
  // Reasoning models spend tokens "thinking" before answering: keep a floor so answers are never empty,
  // and switch Qwen's thinking off (faster, and the private TEE path stays cheap).
  const body = { model, messages, max_tokens: Math.max(maxTokens, 600), temperature };
  if (/^qwen\//i.test(model)) body.chat_template_kwargs = { enable_thinking: false };
  if (json) body.response_format = { type: 'json_object' };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEARAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok) throw new Error(`NEAR AI ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await r.json();
      try { const p = (await prices())[model] || {}; const u = d.usage || {}; addUsage((u.prompt_tokens || 0) * Number(p.prompt || 0) + (u.completion_tokens || 0) * Number(p.completion || 0)); } catch {}
      const text = d.choices?.[0]?.message?.content?.trim() ?? '';
      const clean = stripThink(text);
      if (!clean) {
        // reasoning ate the budget: retry with a bigger one instead of returning an empty answer
        body.max_tokens = Math.min(body.max_tokens * 3, 4000);
        throw new Error('empty completion');
      }
      return { text: clean, id: d.id, model: d.model || model };
    } catch (e) {
      if (attempt === 2) { console.warn('  llm error:', e.message); return null; }
      await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
    }
  }
  return null;
}

function stripThink(t) {
  return t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function chatJson(messages, opts = {}) {
  const r = await chat(messages, { ...opts, json: true, temperature: opts.temperature ?? 0.4 });
  if (!r) return null;
  const m = r.text.match(/\{[\s\S]*\}/);
  try { return { ...JSON.parse(m ? m[0] : r.text), _model: r.model }; } catch { return null; }
}

/** Fetch the TEE attestation for the model and return a compact commitment for on-chain storage. */
export async function attestation(model = PRIVATE_MODEL, chatId) {
  if (!hasKey()) return null;
  try {
    const nonce = crypto.randomBytes(32).toString('hex');
    const r = await fetch(`${BASE}/attestation/report?model=${encodeURIComponent(model)}&provider=near&include_tls_fingerprint=false&signing_algo=ecdsa&nonce=${nonce}`, {
      headers: { accept: 'application/json', 'x-no-aliasing': 'true', authorization: `Bearer ${process.env.NEARAI_API_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return null;
    const raw = await r.text();
    let signer = null;
    try {
      const j = JSON.parse(raw);
      signer = j.signing_address || j.model_attestations?.[0]?.signing_address || j.all_attestations?.[0]?.signing_address || null;
    } catch {}
    let sig = null;
    if (chatId) {
      try {
        const s = await fetch(`${BASE}/signature/${chatId}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, {
          headers: { authorization: `Bearer ${process.env.NEARAI_API_KEY}` }, signal: AbortSignal.timeout(20_000),
        });
        if (s.ok) sig = (await s.json()).signature?.slice(0, 20) || null;
      } catch {}
    }
    const digest = crypto.createHash('sha256').update(raw).digest('hex');
    return `nearai-tee:${model}:report-sha256=${digest}${signer ? `:signer=${signer}` : ''}${sig ? `:sig=${sig}…` : ''}:nonce=${nonce.slice(0, 16)}`;
  } catch {
    return null;
  }
}

// ── Private job envelopes ── AES-256-GCM; ciphertext goes on-chain, plaintext only reaches TEE inference.
const DEFAULT_SECRET = 'hivemind-demo-envelope';
const envKey = (secret = process.env.HIVE_ENVELOPE_SECRET || DEFAULT_SECRET) => crypto.createHash('sha256').update(secret).digest();
export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', envKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}
export function open(sealed) {
  if (!sealed.startsWith('enc:v1:')) return sealed;
  const b = Buffer.from(sealed.slice(7), 'base64');
  for (const key of [envKey(), envKey(DEFAULT_SECRET)]) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch {}
  }
  return '[sealed: envelope key unavailable to this runtime]';
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
