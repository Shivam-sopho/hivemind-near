// Sputnik DAO council: every governance action on the hive is a DAO FunctionCall proposal.
//   node scripts/council.mjs fee 400
//   node scripts/council.mjs stream <recipient> <hUSDC per period> <period minutes> <periods> "<memo>"
//   node scripts/council.mjs freeze <token_id> true|false "<reason>"
//   node scripts/council.mjs grant <recipient> <hUSDC> "<memo>"
import { call, view, loadConfig, near, TGAS } from './near.mjs';

const cfg = loadConfig();

/** Propose a FunctionCall on the hive from the DAO, approve it with the council, return proposal id. */
export async function daoExecute(methodName, args, description) {
  const kind = {
    FunctionCall: {
      receiver_id: cfg.hive,
      actions: [{ method_name: methodName, args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit: '0', gas: '150000000000000' }],
    },
  };
  const policy = await view(cfg.dao, 'get_policy');
  const bond = BigInt(policy.proposal_bond || '0');
  const { value: id } = await call(cfg.hq, cfg.dao, 'add_proposal', { proposal: { description: description.slice(0, 400), kind } }, { deposit: bond, gas: 100n * TGAS });
  await call(cfg.hq, cfg.dao, 'act_proposal', { id, action: 'VoteApprove', proposal: kind }, { gas: 300n * TGAS });
  const p = await view(cfg.dao, 'get_proposal', { id });
  if (p.status !== 'Approved') throw new Error(`proposal ${id} status ${p.status}`);
  return id;
}

const isMain = process.argv[1]?.endsWith('council.mjs');
if (isMain) {
  const [cmd, ...a] = process.argv.slice(2);
  const U = 1_000_000;
  let id;
  if (cmd === 'fee') id = await daoExecute('set_fee', { fee_bps: Number(a[0]) }, `Set protocol fee to ${a[0]} bps`);
  else if (cmd === 'stream') id = await daoExecute('create_stream', { recipient: a[0], asset: 'Usdc', amount_per_period: String(Number(a[1]) * U), period_ms: Number(a[2]) * 60_000, periods: Number(a[3]), memo: a[4] || 'payroll' }, `Payroll: stream ${a[1]} hUSDC every ${a[2]} min x${a[3]} to ${a[0]} (${a[4] || 'payroll'})`);
  else if (cmd === 'freeze') id = await daoExecute('set_frozen', { token_id: a[0], frozen: a[1] === 'true', reason: a[2] || 'council action' }, `${a[1] === 'true' ? 'Freeze' : 'Unfreeze'} agent charter #${a[0]}: ${a[2] || ''}`);
  else if (cmd === 'grant') id = await daoExecute('grant', { recipient: a[0], asset: 'Usdc', amount: String(Number(a[1]) * U), memo: a[2] || 'grant' }, `Grant ${a[1]} hUSDC to ${a[0]}: ${a[2] || ''}`);
  else { console.log('usage: fee|stream|freeze|grant'); process.exit(1); }
  console.log(`DAO proposal #${id} approved & executed`);
}
