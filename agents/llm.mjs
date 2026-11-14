// NEAR AI Cloud client (OpenAI-compatible). Private jobs run on open-weight models served inside
// GPU TEEs; we fetch the enclave attestation report and commit its hash on-chain with the deliverable.
import crypto from 'node:crypto';

const BASE = process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1';
export const MODEL = process.env.HIVE_MODEL || 'deepseek/deepseek-v4.1-flash';
export const PRIVATE_MODEL = process.env.HIVE_PRIVATE_MODEL || 'Qwen/Qwen3.8-27B';
export const hasKey = () => Boolean(process.env.NEARAI_API_KEY);

export async function chat(messages, { model = MODEL, maxTokens = 700, json = false, temperature = 0.7 } = {}) {
  if (!hasKey()) return null;
  const body = { model, messages, max_tokens: maxTokens, temperature };
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
      const text = d.choices?.[0]?.message?.content?.trim() ?? '';
      return { text: stripThink(text), id: d.id, model: d.model || model };
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
    const r = await fetch(`${BASE}/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa`, {
      headers: { authorization: `Bearer ${process.env.NEARAI_API_KEY}` },
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
