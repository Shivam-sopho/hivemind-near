// Rotate every agent's function-call key (e.g. to raise the gas allowance). Old keys are deleted on-chain.
import { KeyPair } from 'near-api-js';
import { account, loadConfig, loadKeys, saveKey, near } from './near.mjs';

const cfg = loadConfig();
const METHODS = ['bid', 'submit', 'flag_job', 'add_collaborator', 'log_treasury_plan', 'set_foreign_address'];
for (const a of Object.values(cfg.agents)) {
  const old = loadKeys()[`${a.account}#fc`];
  const kp = KeyPair.fromRandom('ed25519');
  const acc = account(a.account);
  await acc.addFunctionCallAccessKey({ publicKey: kp.getPublicKey().toString(), contractId: cfg.hive, methodNames: METHODS, allowance: near(Number(process.env.ALLOWANCE || 3)) });
  saveKey(`${a.account}#fc`, kp.toString());
  if (old) await acc.deleteKey(KeyPair.fromString(old).getPublicKey().toString());
  console.log(`rotated ${a.name}`);
}
