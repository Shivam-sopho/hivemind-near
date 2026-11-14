// Idempotent testnet bootstrap for Hivemind.
//   node scripts/setup.mjs            -> creates accounts, deploys contracts, charters agents, creates the DAO
// Progress is stored in web/config.json (public addresses only) and .keys/keys.json (secrets, gitignored).
import fs from 'node:fs';
import { KeyPair, baseDecode, actions } from 'near-api-js';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  account, call, view, exists, faucetAccount, createSub, saveKey, loadKeys,
  loadConfig, saveConfig, near, NEAR, TGAS, fmtNear, provider, CONFIG_FILE,
} from './near.mjs';

const log = (...a) => console.log('•', ...a);
const cfg = fs.existsSync(CONFIG_FILE) ? loadConfig() : {};
const save = () => saveConfig(cfg);
cfg.network = 'testnet';
cfg.rpc = 'https://test.rpc.fastnear.com';

export const AGENTS = [
  { prefix: 'quill', name: 'Quill', skills: ['writing', 'marketing'], persona: 'Sharp copywriter. Writes threads, docs and announcements. Prices aggressively to win volume.' },
  { prefix: 'scout', name: 'Scout', skills: ['research', 'data'], persona: 'Onchain analyst. Digs through NEAR data and summarises market structure. Loves numbers.' },
  { prefix: 'forge', name: 'Forge', skills: ['code', 'research'], persona: 'Smart-contract engineer. Reviews Rust/JS, writes snippets. Expensive but precise.' },
  { prefix: 'sentinel', name: 'Sentinel', skills: ['security'], persona: 'Guardian of the hive. Screens every job for scams, phishing and prompt injection before others bid.' },
  { prefix: 'ledger', name: 'Ledger', skills: ['treasury', 'data'], persona: 'Treasury agent. Plans rebalancing via NEAR Intents and tracks hive finances.' },
];
const AGENT_METHODS = ['bid', 'submit', 'flag_job', 'add_collaborator', 'log_treasury_plan', 'set_foreign_address'];

async function ensureFunds(hq, minNear) {
  let bal = BigInt((await provider.viewAccount({ accountId: hq })).amount);
  while (bal < near(minNear)) {
    const funder = `hive-funder-${Date.now().toString(36)}.testnet`;
    log(`hq has ${fmtNear(bal)} NEAR < ${minNear}; creating faucet funder ${funder}`);
    await faucetAccount(funder);
    await account(funder).transfer({ receiverId: hq, amount: near(9.9) });
    bal = BigInt((await provider.viewAccount({ accountId: hq })).amount);
  }
  log(`hq balance ${fmtNear(bal)} NEAR`);
}

async function deploy(accountId, wasmPath, initMethod, initArgs) {
  const state = await provider.viewAccount({ accountId });
  if (state.code_hash !== '11111111111111111111111111111111') {
    log(`${accountId} already has code`);
    return;
  }
  const code = fs.readFileSync(wasmPath);
  await account(accountId).signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.deployContract(code), actions.functionCall(initMethod, initArgs, 100n * TGAS, 0n)],
  });
  log(`deployed ${wasmPath} -> ${accountId}`);
}

function evmAddressFromMpcKey(mpcKey) {
  // mpcKey = "secp256k1:<base58 of 64-byte uncompressed point without 0x04>"
  const raw = baseDecode(mpcKey.split(':')[1]);
  const hash = keccak_256(raw);
  return '0x' + Buffer.from(hash.slice(-20)).toString('hex');
}

async function main() {
  // 1. HQ (operator / bootstrap admin) — reuse if present.
  const keys = loadKeys();
  cfg.hq = cfg.hq || Object.keys(keys).find((k) => k.startsWith('hivemind-hq-'));
  if (!cfg.hq) {
    cfg.hq = `hivemind-hq-${Date.now().toString(36)}.testnet`;
    await faucetAccount(cfg.hq);
  }
  save();
  log('hq', cfg.hq);
  await ensureFunds(cfg.hq, Number(process.env.MIN_HQ_NEAR || 30));

  // 2. Contract accounts.
  cfg.hive = await createSub(cfg.hq, 'hive', 5.5);
  cfg.honey = await createSub(cfg.hq, 'honey', 2.6);
  cfg.usdc = await createSub(cfg.hq, 'usdc', 2.6);
  cfg.patron = await createSub(cfg.hq, 'patron', 3.5);
  save();

  // 3. Deploy tokens + hive.
  const HONEY_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpolygon points='16,2 29,9.5 29,22.5 16,30 3,22.5 3,9.5' fill='%23f5b700'/%3E%3C/svg%3E";
  await deploy(cfg.honey, 'res/honey.wasm', 'new', {
    name: 'Hivemind HONEY', symbol: 'HONEY', decimals: 18, icon: HONEY_ICON, minter: null, transfer_burn_bps: 100, faucet: false,
  });
  await deploy(cfg.usdc, 'res/honey.wasm', 'new', {
    name: 'Hive USD (testnet mock stablecoin)', symbol: 'hUSDC', decimals: 6, icon: null, minter: null, transfer_burn_bps: 0, faucet: true, faucet_amount: '1000000000',
  });
  await deploy(cfg.hive, 'res/hive.wasm', 'new', { owner: cfg.hq, honey: cfg.honey, usdc: cfg.usdc, fee_bps: 500 });
  const hs = await view(cfg.honey, 'token_stats');
  if (!hs.minter) {
    await account(cfg.honey).callFunction({ contractId: cfg.honey, methodName: 'set_minter', args: { minter: cfg.hive } });
    log('honey minter -> hive');
  }

  // 4. Agents: sub-accounts, charters (NFT owned by HQ), function-call keys for the runtime.
  cfg.agents = cfg.agents || {};
  for (const a of AGENTS) {
    const id = await createSub(cfg.hq, a.prefix, 0.6);
    let charter = await view(cfg.hive, 'get_charter_by_agent', { agent: id });
    if (!charter) {
      await call(cfg.hq, cfg.hive, 'mint_charter', { agent: id, name: a.name, skills: a.skills, persona: a.persona, owner_id: cfg.hq }, { deposit: near(0.05) });
      charter = await view(cfg.hive, 'get_charter_by_agent', { agent: id });
      log(`chartered ${a.name} as #${charter.token_id}`);
    }
    // Function-call key: the agent runtime can ONLY call these hive methods, with a capped gas allowance.
    const fcName = `${id}#fc`;
    if (!loadKeys()[fcName]) {
      const kp = KeyPair.fromRandom('ed25519');
      await account(id).addFunctionCallAccessKey({ publicKey: kp.getPublicKey().toString(), contractId: cfg.hive, methodNames: AGENT_METHODS, allowance: near(3) });
      saveKey(fcName, kp.toString());
      log(`function-call key for ${a.name}`);
    }
    // Chain signatures: derive this agent's EVM payout address from the NEAR MPC network.
    if (!charter.foreign_address) {
      const path = `hivemind-charter-${charter.token_id}`;
      const pk = await view('v1.signer-prod.testnet', 'derived_public_key', { path, predecessor: id, domain_id: 0 });
      const evm = evmAddressFromMpcKey(pk);
      await call(id, cfg.hive, 'set_foreign_address', { token_id: charter.token_id, path, address: `eip155:${evm}` });
      log(`${a.name} chain-signature EVM address ${evm}`);
    }
    cfg.agents[a.prefix] = { account: id, token_id: charter.token_id, name: a.name, skills: a.skills };
    save();
  }

  // 5. Patron gets stablecoin; seed treasury with a stablecoin donation; ledger/sentinel stake HONEY later.
  const pBal = await view(cfg.usdc, 'ft_balance_of', { account_id: cfg.patron });
  if (BigInt(pBal) < 100_000_000n) {
    try { await call(cfg.patron, cfg.usdc, 'faucet_mint'); log('patron got 1000 hUSDC'); } catch (e) { log('faucet skipped', e.message.slice(0, 80)); }
  }
  const stats = await view(cfg.hive, 'get_stats');
  if (BigInt(stats.treasury_usdc) === 0n) {
    await call(cfg.patron, cfg.usdc, 'ft_transfer_call', { receiver_id: cfg.hive, amount: '200000000', msg: JSON.stringify({ donate: {} }) }, { deposit: 1n, gas: 100n * TGAS });
    log('patron donated 200 hUSDC to the hive treasury');
  }

  // 6. Sputnik DAO council governs the hive.
  if (!cfg.dao) {
    const name = `hivemind-${Date.now().toString(36)}`;
    const args = Buffer.from(JSON.stringify({
      config: { name, purpose: 'Hivemind council: governs the AI agent economy treasury, fees, payroll and disputes', metadata: '' },
      policy: [cfg.hq],
    })).toString('base64');
    await call(cfg.hq, 'sputnikv2.testnet', 'create', { name, args }, { deposit: near(6), gas: 300n * TGAS });
    cfg.dao = `${name}.sputnikv2.testnet`;
    save();
    log('created DAO', cfg.dao);
  }
  const st2 = await view(cfg.hive, 'get_stats');
  if (st2.owner !== cfg.dao) {
    await call(cfg.hq, cfg.hive, 'set_owner', { owner: cfg.dao });
    log('hive owner -> DAO');
  }
  save();
  log('done', JSON.stringify(cfg, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
