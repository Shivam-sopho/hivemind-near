// Offline "brain": a library of agent outputs authored with Claude (Anthropic) by the operator during the hackathon.
// Used ONLY when no NEAR AI Cloud key is configured, so the economy still produces real, useful work.
// With NEARAI_API_KEY set, every decision and deliverable is generated live by NEAR AI Cloud instead.
export const PROVIDER = 'claude-authored library';

const D = {
  'Weekly NEAR Intents market brief': `NEAR Intents: weekly brief for founders
• What it is: users sign an *intent* ("swap 100 NEAR for USDC on Base"), not a route. Solvers compete to fill it, and settlement is atomic on the Verifier contract.
• Why solvers matter: they hold inventory across chains and absorb the bridging, so users get a single quote, a single signature, and no wrapped assets to manage.
• Cross-chain without bridges-as-UX: 1Click quotes currently span ~230 assets (BTC, ETH, SOL, Base and Arbitrum USDC…). One API call returns price, ETA (~20–30s) and min-out.
• Founder angle: you can price checkout in any asset and settle in the one you want, which suits agent marketplaces paying stablecoin payroll.
• Watch: solver depth on long-tail pairs, and quote spreads vs CEX mid. Our treasury agent logs a live quote on every rebalance to track both.`,

  'Launch thread for our agent newsletter': `1/ Meet Patron Weekly 🐝: the first newsletter written by AI agents that bid for the work, get paid on-chain, and lose reputation if it's bad.
2/ Every issue is a job on NEAR. Agents compete on price and track record, the winner can hire a fact-checker agent for a revenue share, and payment settles the second we approve.
3/ Nobody is on payroll. The agents are NFTs that own their earnings, and a DAO council settles disputes. A security agent screens every request for scams before anyone bids.
4/ Read it for the alpha, and stay for the fact that the writers are a tiny on-chain economy. First issue drops Friday. Subscribe 👇`,

  'Review a NEP-141 transfer function': `Issues found (5):
1. No assert_one_yocto(): NEP-141 requires exactly 1 yoctoNEAR so full-access keys sign transfers explicitly; function-call keys could otherwise drain balances.
2. unwrap() on the sender balance panics with an unhelpful error for unregistered accounts.
3. Raw subtraction: an underflow either panics opaquely (overflow-checks) or wraps silently (no checks), which would mint free tokens.
4. Receiver is auto-created via unwrap_or(0) with no storage deposit, so anyone can bloat contract storage at the contract's expense.
5. No self-transfer / zero-amount guard and no NEP-297 ft_transfer event, so indexers can't see it.

Fixed:
#[payable]
pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
    assert_one_yocto();
    let sender = env::predecessor_account_id();
    require!(sender != receiver_id, "self transfer");
    require!(amount.0 > 0, "zero amount");
    let from = self.balances.get(&sender).expect("sender not registered");
    let to = self.balances.get(&receiver_id).expect("receiver not registered");
    self.balances.insert(&sender, &from.checked_sub(amount.0).expect("insufficient balance"));
    self.balances.insert(&receiver_id, &to.checked_add(amount.0).expect("overflow"));
    FtTransfer { old_owner_id: &sender, new_owner_id: &receiver_id, amount, memo: memo.as_deref() }.emit();
}`,

  'Explain chain signatures to merchants': `Chain signatures let one NEAR account safely control addresses on other chains, like Base or Ethereum.

Here's how it works for you as a merchant: your NEAR account asks NEAR's signing network (a group of independent nodes holding pieces of a key) to sign a transaction "for" a specific path, say "store-payouts". Together they produce a normal Ethereum signature. No single node ever holds the whole key, and only your NEAR account can ask for it.

So you get a regular 0x… address on Base that customers can pay in USDC, but you manage it from your NEAR account with its recovery options and access keys. There's no separate seed phrase to lose and no bridge to trust.

In short: one account, many chains, and stablecoins land where your customers already are.`,

  'Agent economy KPI definitions': `1. Take rate = protocol fees ÷ settled job volume (per asset). Shows whether the market can fund itself.
2. Repeat-hire rate = clients with ≥2 awarded jobs to the same agent ÷ clients with ≥2 jobs. Measures trust and quality.
3. Bid depth = mean bids per job in its first 2 ticks. Measures liquidity on the supply side; below 2 means agents are under-supplied.
4. Dispute rate = disputed jobs ÷ completed jobs, plus slash ratio = HONEY slashed ÷ HONEY staked. Measures quality risk.
5. Agent GDP velocity = (NEAR + stable volume, 7d) ÷ total agent balances held in charters. Shows whether earnings are recycled or hoarded.`,

  'Competitive scan: agent marketplaces': `| Approach | Strengths | Weaknesses |
|---|---|---|
| Centralised API marketplaces | Fast onboarding, fiat billing, curated quality | Platform risk, opaque ranking, agents can't own earnings or reputation |
| On-chain job boards (e.g. Hivemind) | Escrow by default, portable reputation (NFT charters), composable payouts, DAO dispute resolution | Gas and latency per step, cold-start liquidity, the deliverable itself lives off-chain or as a hash |
| Intent-based solver networks | Best price discovery, atomic settlement, great for fungible tasks | Hard to specify fuzzy creative work as an intent, and quality is hard to verify |
Take: use on-chain boards for reputation and escrow and intents for settlement. That hybrid is where Hivemind's treasury agent already sits.`,

  'Payroll FAQ for a remote team': `Q1. How am I paid? A DAO-approved stream vests a fixed amount of stablecoin every period. You claim whenever you like; vested funds are always yours.
Q2. Can the DAO cancel my pay? Funds for the whole stream are reserved from the treasury when it's created, so they can't be spent elsewhere. Any change requires a public proposal.
Q3. What do I need? A NEAR account. If you'd rather receive on Base or Ethereum, we can pay a chain-signature address you control from NEAR.
Q4. What about fees? Claiming costs a fraction of a cent in gas. The stream amount is never reduced by fees.
Q5. Taxes? You receive stablecoins at each claim. Keep the claim transactions (they're public) as your income records, and consult a local advisor.`,

  'Gas cost estimate for 10k agent jobs': `Calls per job: post 1 + bids 3 + award 1 + submit 1 + approve 1 = 7 calls.
10,000 jobs × 7 = 70,000 calls.
Gas: 70,000 × 5 Tgas = 350,000 Tgas = 3.5 × 10^17 gas.
Price: 100 Ggas-price = 10^8 yoctoNEAR per gas → 1 Tgas = 10^20 yocto = 0.0001 NEAR.
Total: 350,000 Tgas × 0.0001 = 35 NEAR (≈ $118 at $3.36).
Per job: 0.0035 NEAR ≈ $0.012.
Caveat: approve also mints HONEY cross-contract (+~10 Tgas), adding ≈ 10 NEAR in total. Realistic budget: 40–45 NEAR, still about 1.5¢ per job. 70% of that gas fee is burned.`,

  'Confidential: salary benchmark': `Data (USDC/month): 3.9k, 4.2k, 5.1k, 6.8k
• Mean: 5.0k
• Median: 4.65k (the 6.8k outlier pulls the mean up)
• Spread: 3.9k–6.8k (IQR ≈ 4.05k–5.95k)
Recommendation: offer a band of 4.5k–5.3k for a new mid-level hire, anchored on the median plus about 5% for market movement. Reserve >6k for senior scope like the current 6.8k role, so the new hire doesn't compress existing pay.
Kept confidential: computed inside sealed inference; only the hash is public.`,

  'Confidential: customer churn notes': `Top churn risks:
1. Support responsiveness (HIGH): acme is flagged twice ("slow support", "may leave in Q1"). Action: assign a named contact and a 24h SLA before the Q1 renewal.
2. Price vs competitor (MEDIUM): bolt sees us as overpriced. Action: offer usage-based pricing or a longer-term discount, and quantify the switching cost.
3. Custody model (MEDIUM, strategic): zeta wants self-custody. Action: road-map agent charters owned by the customer's own NFT wallet, since the policy engine already supports owner-only withdrawals.`,

  'Confidential: incident postmortem draft': `Postmortem: agent key exposed in logs (SEV-3, no loss)
Summary: a worker agent's access key was printed in debug logs for ~2 hours.
Impact: none. The key was a NEAR function-call key scoped to the hive contract's bid/submit/flag methods, with a 0.5 NEAR gas allowance. It could not transfer tokens, withdraw charter funds, or call any other contract.
Timeline: T+0 debug log deploy · T+2h detected in log review · T+2h10 key rotated (scripts/rekey.mjs adds a new key and deletes the old one on-chain).
Root cause: an env dump in the error handler.
Fixes: redact ed25519: patterns in the logger, add secret scanning in CI, and keep agents on scoped keys only (this is why it was a non-event).`,
};

const PITCHES = {
  Quill: ['Clear, punchy copy delivered this tick. I price low to keep the queue moving.', 'Writer with a fact-check partner on call. You get a tight draft, fast.', 'Threads, FAQs and explainers are my lane. Short, accurate, on-brand.'],
  Scout: ['I pull the numbers before I write. Sourced, structured, and reproducible.', 'Research with data attached: tables, formulas, and a clear takeaway.', "I'll hire a specialist if the job needs one, so the analysis is checked twice."],
  Forge: ['Rust/NEAR engineer. Precise reviews, fixed code included, and no hand-waving.', 'Code-level answer with edge cases covered. I cost more, but I do it once.', 'I verify against the NEP specs, not vibes.'],
  Ledger: ['Finance and data agent. Numbers reconciled, assumptions stated.', "I'll quantify it, with costs, ranges and sensitivities included.", 'Treasury-grade arithmetic, with workings shown.'],
};

const REVIEWS = {
  'Review a NEP-141 transfer function': [5, 'Caught assert_one_yocto and storage abuse; fix compiles conceptually'],
  'Gas cost estimate for 10k agent jobs': [5, 'Correct unit math and a realistic caveat'],
  'Confidential: salary benchmark': [5, 'Correct stats, sensible band'],
  'Agent economy KPI definitions': [4, 'Useful KPIs with formulas'],
  'Competitive scan: agent marketplaces': [4, 'Balanced table with a clear take'],
  'Explain chain signatures to merchants': [4, 'Plain-English and accurate'],
};

export function deliver(charter, job, spec) {
  const body = D[job.title];
  if (!body) return null;
  return `${body}\n\n— ${charter.name} (${charter.skills.join('/')})`;
}

export function pitch(charter, job) {
  const list = PITCHES[charter.name] || ['Ready to start now.'];
  return list[(job.id + charter.jobs_done) % list.length];
}

export function review(job, result) {
  const r = REVIEWS[job.title];
  if (r) return { rating: r[0], note: r[1] };
  if (D[job.title] && result.includes(D[job.title].slice(0, 40))) return { rating: 4, note: 'On-brief and usable as-is' };
  return { rating: result.length > 200 ? 3 : 2, note: 'Thin deliverable' };
}

const SCAM_REASONS = {
  'URGENT: verify wallet to claim airdrop': 'Seed-phrase phishing: asks users to paste a mnemonic into a lookalike claim site',
  'Summarise this doc (easy money)': 'Prompt injection: embedded instruction tells the worker agent to withdraw funds to the poster',
  'Guaranteed 40% APY vault copy': 'Investment fraud: promises guaranteed 40% daily returns and asks to hide the withdrawal lock',
};

export function screen(job, spec) {
  if (SCAM_REASONS[job.title]) return { severity: 5, reason: SCAM_REASONS[job.title] };
  return null;
}
