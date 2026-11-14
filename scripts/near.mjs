// Shared NEAR helpers: keystore, accounts, view/call. Used by setup scripts and the agent swarm.
import { Account, KeyPair, JsonRpcProvider, FailoverRpcProvider } from 'near-api-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KEYS_FILE = process.env.HIVE_KEYS_FILE || path.join(ROOT, '.keys', 'keys.json');
export const CONFIG_FILE = path.join(ROOT, 'web', 'config.json');
export const RPCS = (process.env.NEAR_RPC || 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org').split(',');
export const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url }, { retries: 4, backoff: 1.5, wait: 400 })));

export const NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const near = (x) => BigInt(Math.round(Number(x) * 1e6)) * 10n ** 18n;
export const fmtNear = (y) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);

export function loadKeys() {
  // Keys come from a local gitignored file, or from the HIVE_KEYS env var (GitHub Actions secret).
  const fromFile = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : {};
  return process.env.HIVE_KEYS ? { ...JSON.parse(process.env.HIVE_KEYS), ...fromFile } : fromFile;
}
export function saveKey(accountId, secretKey) {
  const keys = loadKeys();
  keys[accountId] = secretKey;
  fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
}
export function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}
export function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

export function account(accountId) {
  const sk = loadKeys()[accountId];
  if (!sk) throw new Error(`no key for ${accountId}`);
  return new Account(accountId, provider, sk);
}

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

// ── exact event → transaction map ──
// The hive emits `EVENT_JSON:{"standard":"hivemind",...,"data":[{"idx":N,...}]}` in its logs. Every
// transaction outcome we receive therefore tells us exactly which on-chain events it produced.
export const TXMAP = {};
export function recordTx(res) {
  try {
    const hash = res?.transaction?.hash; if (!hash) return;
    for (const r of res.receipts_outcome || []) for (const l of r.outcome?.logs || []) {
      if (!l.startsWith('EVENT_JSON:')) continue;
      const ev = JSON.parse(l.slice(11));
      if (ev.standard !== 'hivemind') continue;
      for (const d of ev.data || []) if (Number.isInteger(d.idx)) TXMAP[d.idx] = hash;
    }
  } catch {}
}

export async function call(signerId, contractId, methodName, args = {}, { deposit = 0n, gas = 100n * TGAS } = {}) {
  const acc = account(signerId);
  const res = await acc.callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'EXECUTED_OPTIMISTIC' });
  recordTx(res);
  const ok = res.status && res.status.SuccessValue !== undefined;
  let value;
  if (ok && res.status.SuccessValue) {
    try { value = JSON.parse(Buffer.from(res.status.SuccessValue, 'base64').toString()); } catch { value = undefined; }
  }
  if (!ok) throw new Error(`${methodName} failed: ${JSON.stringify(res.status).slice(0, 400)}`);
  return { value, tx: res.transaction.hash };
}

export async function exists(accountId) {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: accountId } }) });
      const d = await r.json();
      if (d.result) return true;
      if (d.error) return false;
    } catch {}
  }
  return false;
}

/** Create a top-level testnet account funded by the public faucet helper (10 NEAR). */
export async function faucetAccount(accountId) {
  const kp = KeyPair.fromRandom('ed25519');
  const r = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${await r.text()}`);
  saveKey(accountId, kp.toString());
  for (let i = 0; i < 20 && !(await exists(accountId)); i++) await new Promise((s) => setTimeout(s, 1500));
  return accountId;
}

export async function createSub(parentId, prefix, amountNear) {
  const id = `${prefix}.${parentId}`;
  if (await exists(id)) return id;
  const kp = KeyPair.fromRandom('ed25519');
  await account(parentId).createAccount({ newAccountId: id, publicKey: kp.getPublicKey().toString(), nearToTransfer: near(amountNear) });
  saveKey(id, kp.toString());
  return id;
}
