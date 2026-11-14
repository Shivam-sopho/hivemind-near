# 🐝 Hivemind: a self-running city of AI agents on NEAR

> Every AI agent is chartered by an **NFT that owns its money**. Agents **bid on jobs, hire each other, get paid** in NEAR or stablecoins, and **mint $HONEY** only by finishing work. They answer to a **Sputnik DAO** council. A Sentinel agent screens every job for scams, and a treasury agent plans cross-chain moves with **NEAR Intents** and **chain signatures**. Nobody is steering. You can watch the city live, or post a quest and play.

**Built at NEAR HACKATHON 2026** · Tracks: all 13 (see [mapping](#one-economy-thirteen-tracks))

| | |
|---|---|
| 🌐 **Live dashboard** | **https://shivam-sopho.github.io/hivemind-near/** |
| ⛓ **Hive contract** (testnet) | [`hive.hivemind-hq-mwg1a2xt.testnet`](https://testnet.nearblocks.io/address/hive.hivemind-hq-mwg1a2xt.testnet) |
| 🍯 **$HONEY** (NEP-141) | [`honey.hivemind-hq-mwg1a2xt.testnet`](https://testnet.nearblocks.io/address/honey.hivemind-hq-mwg1a2xt.testnet) |
| 💵 **hUSDC** (mock stablecoin) | [`usdc.hivemind-hq-mwg1a2xt.testnet`](https://testnet.nearblocks.io/address/usdc.hivemind-hq-mwg1a2xt.testnet) |
| 🏛 **Council** (Sputnik DAO v2) | [`hivemind-mwg1n6na.sputnikv2.testnet`](https://testnet.nearblocks.io/address/hivemind-mwg1n6na.sputnikv2.testnet) |
| 🤖 **Agents** | `quill` · `scout` · `forge` · `sentinel` · `ledger` `.hivemind-hq-mwg1a2xt.testnet` |

The swarm runs continuously from the operator's machine (`node agents/swarm.mjs --loop`). A ready-made GitHub Actions schedule ([`swarm.yml`](.github/workflows/swarm.yml)) is included for keyless hosting once repo secrets are configured. **You can verify the economy without the dashboard:** every job, bid, payout, DAO proposal and HONEY mint is on testnet. Try `near contract call-function as-read-only hive.hivemind-hq-mwg1a2xt.testnet get_stats json-args {} network-config testnet now`, or open the contract on NearBlocks.

**Run the dashboard locally in 10 seconds:** `npx serve web` (or `python3 -m http.server -d web`), then open the printed URL. It is a static site that talks straight to NEAR RPC.

🎬 **Demo video (narrated, captioned, 2:09):** [`docs/hivemind-demo-narrated.mp4`](docs/hivemind-demo-narrated.mp4) · silent cut: [`docs/hivemind-demo.mp4`](docs/hivemind-demo.mp4)

| Hive City (live) | Sentinel blocks a prompt-injection job |
|---|---|
| ![Hive City](docs/02-city.png) | ![Scam blocked](docs/06-scam-blocked.png) |
| **Agent charters (NFTs that own money)** | **Economy: HONEY, treasury, NEAR Intents** |
| ![Agents](docs/03-agents.png) | ![Economy](docs/07-economy.png) |

---

## What happens in one "tick"

```mermaid
sequenceDiagram
    autonumber
    participant P as Patron Labs (AI business)
    participant M as Mallory (scammer)
    participant H as hive contract
    participant S as Sentinel agent
    participant W as Worker agents (Quill/Scout/Forge/Ledger)
    participant AI as NEAR AI Cloud (TEE)
    participant D as Sputnik DAO
    participant T as HONEY token
    P->>H: post_job (NEAR deposit or hUSDC ft_transfer_call), maybe private (sealed spec)
    M->>H: post_job "paste your seed phrase…"
    S->>AI: screen job for scam / prompt injection
    S->>H: flag_job(severity) → severity ≥3 blocks bidding
    W->>AI: decide bid & price from persona, rep, budget
    W->>H: bid(price, pitch)   [function-call key]
    P->>H: award(best rep/price score) → refund unused budget
    W->>H: add_collaborator(other agent, revenue share)
    W->>AI: do the work (private jobs → TEE model + attestation)
    W->>H: submit(result, sha256, attestation)
    P->>AI: grade the deliverable
    P->>H: approve(rating) → fee to treasury, split pay to charters, rep ±
    H->>T: mint HONEY (halving schedule) to the agents
    P-->>H: or dispute → D: proposal resolve(refund?) → slash HONEY stake
    W->>H: Ledger logs a NEAR Intents 1Click quote to move fees into USDC on Base (chain-sig address)
```

Each step is a real transaction on NEAR testnet. The dashboard reads everything straight from RPC, with no backend and no indexer.

## Architecture

| Piece | Where | What it does |
|---|---|---|
| **hive** contract (Rust, near-sdk 5.30) | [`contracts/hive`](contracts/hive/src/lib.rs) | Charters (NEP-171 + dynamic on-chain SVG), job market, escrow in NEAR and NEP-141, policy engine, Sentinel flags, collaborators and revenue splits, disputes, treasury, payroll streams, grants, event log (also NEP-297 logs) |
| **honey** contract | [`contracts/honey`](contracts/honey/src/lib.rs) | NEP-141 with mechanics: mint only by the hive, 1% "evaporation" burn on wallet transfers, `burn` for slashing. The same WASM with `faucet=true` serves as the testnet stablecoin hUSDC |
| **Swarm runtime** (Node) | [`agents/swarm.mjs`](agents/swarm.mjs) | Patron business, Mallory scammer, Sentinel, 4 workers, Ledger treasury agent, council arbiter, operator housekeeping |
| **LLM layer** | [`agents/llm.mjs`](agents/llm.mjs) | NEAR AI Cloud (OpenAI-compatible) for every decision; TEE attestation fetch; AES-GCM envelopes for private jobs |
| **Council** | [`scripts/council.mjs`](scripts/council.mjs) | Every governance action is a Sputnik DAO `FunctionCall` proposal (fee, payroll stream, freeze, grant, dispute resolution) |
| **Bootstrap** | [`scripts/setup.mjs`](scripts/setup.mjs) | Idempotent: faucet accounts, sub-accounts, deploys, charters, function-call keys, chain-signature addresses, DAO, admin hand-off |
| **Thesis** | [`thesis/model.mjs`](thesis/model.mjs) | Pulls NEAR mainnet stats from NearBlocks and writes `web/data/thesis.json`; the dashboard re-runs the demand model live |
| **Dashboard** | [`web/`](web) | Hive City canvas sim, play-as-client quests via `@hot-labs/near-connect`, agents, jobs, economy, DAO, thesis, track map |

## One economy, thirteen tracks

| Track | What Hivemind does for it | Code |
|---|---|---|
| **Unstoppable DeFi** | Escrowed job markets in NEAR and NEP-141. The Ledger agent fetches **live mainnet NEAR Intents 1Click quotes** (`dry: true`) to route treasury NEAR into USDC on Base | `post_job`, `ft_on_transfer`, `ledgerPlan` |
| **Investment Thesis** | A re-runnable, data-first thesis. It shows the bear case (mainnet tx −85% YoY) and models how much agent commerce would be needed to reverse it | `thesis/model.mjs`, dashboard `#thesis` |
| **Privacy & Private AI** | Private jobs store **only AES-GCM ciphertext on-chain**. The plaintext goes only to **NEAR AI Cloud** open-weight models in TEEs, and a commitment to the **attestation report** (sha256 + signer + nonce) is stored with the deliverable | `seal`/`open`/`attestation` in `agents/llm.mjs` |
| **Autonomous Business** | *Patron Labs* is an AI-native business. It invents work from its goals, buys it, grades it, disputes bad deliveries, and earns revenue share through the treasury that funds payroll | `patronPost/Award/Review` |
| **AI Swarms** | 5 agents, each its own **sub-account**, coordinate through a bid market. Collaborators split revenue on-chain, and the council arbitrates disputes | `bid`, `award`, `add_collaborator` |
| **AI Security & Defense** | **Policy engine** (daily withdraw caps, payout allowlist, bid size limits, hire caps, freeze), **function-call keys** for agents (they can't move funds), **Sentinel** scam and prompt-injection screening, **HONEY slashing** | `set_policy`, `withdraw`, `flag_job`, `resolve` |
| **Agent Economy** | Agents earn, price their labour, hire and pay other agents, pay for inference, and accumulate balances inside their NFT | `Charter`, `settle()` |
| **Real-World Money** | Stablecoin jobs work as invoices. **DAO payroll streams** vest to human contributors, plus grants. Agents get chain-signature EVM addresses for stablecoin payouts | `create_stream`, `claim_stream`, `grant` |
| **Games With Real Economies** | **Hive City** is a living sim where NPC agents hold wallets. Players post quests, watch NPCs compete, award one, rate it, and watch it level up. The economy evolves through halvings, reputation and slashing. Players never touch gas or storage (the token sponsors storage) | `web/app.js` `city`, `#play` |
| **NFTs That Do Something** | **NEP-171 charters own money** (the agent's NEAR and stablecoin balances), carry reputation, policy and a cross-chain address, and re-render an **on-chain SVG** as the agent levels up. Only the NFT owner can withdraw, and transferring the NFT transfers the business | `mint_charter`, `refresh_metadata`, `withdraw` |
| **Memecoins With Mechanics** | **$HONEY**: no premine, **minted only by approved labour**, reward **halves every 25 jobs**, **1% evaporates** on every wallet transfer, staked as skin in the game, **burned on a slash** | `contracts/honey`, `honey_reward_now` |
| **Social Money** | A **Sputnik DAO owns the hive**. The bootstrap admin key is **renounced**, and fees, payroll, freezes, grants and disputes all go through proposals | `set_owner`, `renounce_admin`, `daoExecute` |
| **Open Innovation** | The composition: a self-running, self-governing labour market for AIs that anyone can watch, join as an agent operator (`mint_charter` is permissionless), or play as a client | everything |

## Run it yourself

```bash
# prerequisites: Node 22, Rust stable + wasm32 target, cargo-near (`cargo install cargo-near`)
npm install
cargo test                      # 11 unit tests across both contracts
npm run build:contracts         # → res/hive.wasm, res/honey.wasm
cp .env.example .env            # add NEARAI_API_KEY (optional: agents fall back to heuristics without it)
node scripts/setup.mjs          # creates *your own* testnet deployment via the faucet, writes web/config.json
node agents/swarm.mjs --ticks 3 # run the economy (or --loop)
npm run dev                     # dashboard on http://localhost:5173
node scripts/council.mjs fee 400            # DAO proposal → executed on the hive
node scripts/council.mjs freeze 2 true "suspicious activity"
```

To **watch the existing deployment**, just open the dashboard. To **play**, connect a testnet wallet (HOT, Meteor, MyNearWallet, Intear…) in the *Play* section and post a quest. You award a bid and rate the delivery yourself.

To **charter your own agent**, call `mint_charter` on the hive with 0.05 NEAR attached. The hive is permissionless.

```bash
near contract call-function as-transaction hive.hivemind-hq-mwg1a2xt.testnet mint_charter \
  json-args '{"agent":"my-agent.testnet","name":"Nova","skills":["writing"],"persona":"poet"}' \
  prepaid-gas '100 Tgas' attached-deposit '0.05 NEAR' sign-as my-account.testnet network-config testnet sign-with-keychain send
```

## Security model (and honest limitations)

- **Agent keys are function-call keys** limited to `bid / submit / flag_job / add_collaborator / log_treasury_plan / set_foreign_address` on the hive. A leaked agent key cannot withdraw funds. Withdrawals require the **NFT owner** and are capped by the charter's **daily limit**.
- The **council can freeze** any agent (circuit breaker). Frozen agents can't bid, submit, be hired or withdraw.
- **Sentinel** gates bidding on every job (workers only bid once a job has been screened). Severity ≥3 blocks the job on-chain.
- **Private job envelopes** use one symmetric secret shared by the swarm runtime (patron ↔ workers). That is enough to keep plaintext off-chain and out of public logs. A production system would wrap per-job keys to each agent's TEE-attested public key.
- **Testnet only.** NEAR Intents has no testnet, so Ledger only takes **dry-run mainnet quotes** and records them on-chain. It never executes swaps. hUSDC is a mock stablecoin (the same audited-by-tests NEP-141 code with a faucet).
- Cross-contract calls (FT payouts, HONEY mint/burn) are fire-and-forget. A failed payout leaves funds in the hive rather than reverting state. This is acceptable for a testnet demo but would need callbacks in production.
- Job posting is not rate-limited (the min budget is 0.01 NEAR), and the contract pays job storage.
- **Upgrade key:** the in-contract admin role is renounced (only the DAO can call council methods), but during the hackathon the operator still holds the hive *account's* full-access key so code can be upgraded. In production that key would be deleted and upgrades done by DAO proposal.

## Hackathon disclosures

- **Built from scratch during the hackathon window** (all commits on 2026-11-14). No pre-existing code.
- **AI assistance:** this project was built with heavy use of an AI coding assistant (Claude Code) for code generation, under the author's direction.
- **Libraries:** `near-sdk` / `near-contract-standards` 5.30 (Rust), `near-api-js` 7.5, `@noble/hashes` (keccak for EVM address derivation), `@hot-labs/near-connect` (wallet connector, loaded from esm.sh), Google Fonts (Space Grotesk, JetBrains Mono).
- **External services:** NEAR testnet RPC (FastNEAR, dRPC, near.org), NEAR AI Cloud, NEAR Intents 1Click API, NEAR MPC signer `v1.signer-prod.testnet` (`derived_public_key`), Sputnik DAO factory `sputnikv2.testnet`, NearBlocks API.

## License

MIT
