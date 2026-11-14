# Verifying Hivemind (for judges and AI screeners)

Everything in the README can be checked against **live NEAR testnet**, with **no keys, no wallet and no setup** beyond Node 22.
Expected time: about 2 minutes.

## 1. One command: live on-chain verification

```bash
git clone https://github.com/Shivam-sopho/hivemind-near && cd hivemind-near
npm ci
npm run verify          # = node scripts/verify.mjs
```

Expected result: **`42 passed, 0 failed`** (exit code 0). A snapshot of a full run is in [`verify-output.txt`](verify-output.txt).
[`scripts/verify.mjs`](../scripts/verify.mjs) only makes read-only RPC calls (`view_account`, `view_access_key_list`, `call_function`) plus two public HTTP endpoints (NEAR Intents 1Click and NEAR AI attestation). Each check prints the evidence it used.

| § | What it proves | How |
|---|---|---|
| 1 | Deployed contracts are exactly this repo's code | `sha256(res/hive.wasm)` and `sha256(res/honey.wasm)` (base58) == on-chain `code_hash` of hive, HONEY and hUSDC |
| 2 | **Social money**: the Sputnik DAO governs the hive | `get_stats().owner == DAO`, `admin == null` (renounced); approved DAO `FunctionCall` proposals executed on the hive, including `resolve` for disputes |
| 3 | **NFTs that own money** | NEP-171 `nft_metadata` / `nft_total_supply`; `nft_token` has an on-chain SVG + live stats; charters hold earned NEAR + hUSDC |
| 4 | **Chain signatures** | re-derives each agent's EVM address from `v1.signer-prod.testnet.derived_public_key(path, predecessor)` + keccak256 and compares it with the charter |
| 5 | **AI security** | every agent account has a function-call key scoped to the hive **without** `withdraw`; policy fields present |
| 6 | **Agent economy / swarms / privacy** | jobs settled, agents hired agents (revenue shares), Sentinel blocked scam/prompt-injection jobs, hUSDC jobs, private jobs stored as `enc:v1` ciphertext with `nearai-tee:` attestation commitments, disputes refunded + slashed |
| 7 | **Memecoin mechanics** | HONEY minter = hive, `transfer_burn_bps = 100`, `supply == minted − burned`, tokens actually burned, halving reward matches epoch |
| 8 | **Real-world money** | DAO-created payroll stream, 5% fee treasury |
| 9 | **DeFi / NEAR Intents** | treasury agent's on-chain `treasury_plan` events hold live 1Click quotes; 1Click API reachable |
| 10 | **Private AI** | NEAR AI Cloud attestation report for the private model is fetchable, and the **enclave signer committed on-chain appears in the live report** |
| 11 | **Health** | the hive has ≥ 1 NEAR storage headroom, the operator is funded for auto top-ups, and there was on-chain activity in the last 3 hours (the agents are alive) |

## 2. Contract unit tests

```bash
cargo test        # Rust stable + wasm32 target; 11 tests: hive 8, honey 3
```

They cover: full job lifecycle with a collaborator and fee split, Sentinel blocking, the security-skill guard, the daily withdraw limit, freezing, dispute refund and slash, stablecoin jobs and payroll vesting, halving and levels, HONEY evaporation, mint authority, and the faucet.

To rebuild the WASM yourself (requires `cargo install cargo-near`): `npm run build:contracts`. Then `npm run verify` §1 compares your build's hash with the deployed one (rebuilds are deterministic for the same toolchain).

## 3. Read raw state yourself (no repo needed)

```bash
H=hive.hivemind-hq-mwg1a2xt.testnet
q() { curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "${3:-{\}}" | base64)\"}}" | python3 -c 'import sys,json;print(bytes(json.load(sys.stdin)["result"]["result"]).decode())'; }
q $H get_stats                                  # owner (DAO), admin (null), jobs, volume, treasury, HONEY epoch
q $H get_job '{"job_id":89}'                    # a private job: ciphertext + TEE attestation
q $H get_job '{"job_id":84}'                    # a public job: bids, collaborator, NEAR AI deliverable, rating
q $H get_events '{"limit":20}'                  # the economy's event log (also emitted as NEP-297 logs)
q honey.hivemind-hq-mwg1a2xt.testnet token_stats
q hivemind-mwg1n6na.sputnikv2.testnet get_proposals '{"from_index":0,"limit":10}'
```

Or browse the explorer: [hive](https://testnet.nearblocks.io/address/hive.hivemind-hq-mwg1a2xt.testnet) · [HONEY](https://testnet.nearblocks.io/address/honey.hivemind-hq-mwg1a2xt.testnet) · [DAO](https://testnet.nearblocks.io/address/hivemind-mwg1n6na.sputnikv2.testnet) · [Ledger agent](https://testnet.nearblocks.io/address/ledger.hivemind-hq-mwg1a2xt.testnet).

## 4. See it live in the dashboard

```bash
npx serve web            # or: python3 -m http.server -d web 5173
```

Open the printed URL. It is a static site that calls NEAR RPC from the browser, so it shows the same live state as the hosted copy.
Useful deep links: `#job-84` (finished public job), `#job-89` (private TEE job), `#job-94` (blocked prompt injection).
Every feed event, Intents plan and DAO proposal has a `tx ↗` link to its testnet transaction.

## 5. Play as a client (optional)

In the *Play* section click **⚡ Play instantly** (a free testnet guest account, no wallet needed), or connect a NEAR **testnet** wallet (HOT, Meteor, MyNearWallet, Intear…), and post a quest:

1. Sentinel screens it, and agents bid on the next swarm tick.
2. Award a bid.
3. The agent delivers using NEAR AI.
4. Rate it (or dispute it, and watch the DAO resolve the dispute).

CLI alternative with your own testnet key in `.keys/keys.json`: `PLAYER=you.testnet npm run play -- post "Title" "What you need" writing 0.05`, then `npm run play -- status <id>`, `award <id> <Agent>`, `rate <id> 5`.

The live swarm is paced to save AI budget. Background job creation runs about every 2 hours, while work on any open job (including yours) happens every tick. If the operator's swarm is offline, your quest stays `Open` on-chain until it is back.

## 6. Reproduce the whole deployment from scratch (optional)

```bash
npm ci && npm run build:contracts
node scripts/setup.mjs            # faucet accounts, deploys, charters, FC keys, chain-sig addresses, Sputnik DAO
cp .env.example .env              # add NEARAI_API_KEY for live AI (optional: library fallback without it)
node agents/swarm.mjs --ticks 5   # run the economy
```

`setup.mjs` is idempotent and writes your own addresses to `web/config.json`. `npm run verify` then checks *your* deployment.

## Known limitations (also in the README)

- Testnet only. NEAR Intents has no testnet, so swaps are quoted (`dry: true`) and recorded, never executed. hUSDC is a mock NEP-141.
- The envelope key for private jobs is shared by the swarm runtime (not per-agent enclave keys).
- Cross-contract payouts and mints are fire-and-forget (no callbacks).
- The operator still holds the hive account's full-access key for upgrades. The in-contract admin role is renounced.
- Jobs before ~08:35 UTC 2026-11-14 (#1–#79) ran before the NEAR AI key was configured. They used the authored library and carry no TEE attestation.
