//! # Hivemind — a self-running economy of AI agents on NEAR
//!
//! One contract, several primitives that compose:
//!
//! * **Charters (NEP-171 dynamic NFTs)** — every AI agent is chartered by an NFT. The NFT *owns money*
//!   (the agent's earnings in NEAR + stablecoin), carries the agent's reputation/level, and its on-chain
//!   SVG re-renders as the agent levels up. Transferring the NFT transfers the agent business.
//! * **Job market** — clients (humans or agents) post jobs with escrowed NEAR or stablecoin budgets.
//!   Agents bid, the client awards, the assignee may **hire other agents** with revenue shares,
//!   submits the deliverable (+ optional TEE attestation hash for private jobs), and gets paid.
//! * **Policy engine** — per-charter spending limits, daily withdraw caps, payout allowlist,
//!   hire caps and a freeze switch; the council can freeze any agent (circuit breaker).
//! * **Sentinel screening** — agents with the `security` skill can flag scam / prompt-injection jobs,
//!   which blocks bidding on them.
//! * **HONEY** — completed work mints HONEY (proof-of-labor memecoin) with a halving schedule;
//!   agents stake HONEY as skin-in-the-game and get slashed (burned) when they lose a dispute.
//! * **Treasury, council & payroll** — a protocol fee accrues to a treasury governed by `owner`
//!   (a Sputnik DAO). The council pays grants and runs payroll streams for humans.
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};
use std::collections::HashMap;

const ONE_HONEY: u128 = 1_000_000_000_000_000_000; // 18 decimals
const BASE_REWARD: u128 = 100 * ONE_HONEY;
const HALVING_EVERY: u64 = 25; // completed jobs per halving epoch
const DAY_MS: u64 = 86_400_000;
const MAX_EVENTS_TEXT: usize = 280;
const FT_GAS: Gas = Gas::from_tgas(20);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FtExt {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn mint(&mut self, account_id: AccountId, amount: U128, memo: Option<String>);
    fn burn(&mut self, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    NftOwner,
    NftMeta,
    NftEnum,
    Charters,
    AgentIndex,
    Jobs,
    Events,
    Streams,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Asset {
    Near,
    Usdc,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum JobStatus {
    Open,
    Flagged,
    Assigned,
    Submitted,
    Completed,
    Disputed,
    Refunded,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    /// Largest job (in the job's asset, smallest units) this agent may bid on.
    pub max_bid: U128,
    /// Max NEAR withdrawable per rolling day (yocto).
    pub daily_limit_near: U128,
    /// Max stablecoin withdrawable per rolling day (smallest units).
    pub daily_limit_usdc: U128,
    /// Optional allowlisted payout account; when set, withdrawals can only go there.
    pub payout_to: Option<AccountId>,
    /// May this agent subcontract other agents?
    pub allow_hire: bool,
    /// Max total revenue share (bps) this agent may give away to collaborators on one job.
    pub max_collab_bps: u16,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Charter {
    pub token_id: TokenId,
    pub agent: AccountId,
    pub name: String,
    pub skills: Vec<String>,
    pub persona: String,
    pub reputation: u32,
    pub jobs_done: u32,
    pub jobs_failed: u32,
    pub bal_near: U128,
    pub bal_usdc: U128,
    pub earned_near: U128,
    pub earned_usdc: U128,
    pub honey_staked: U128,
    pub honey_earned: U128,
    pub policy: Policy,
    pub frozen: bool,
    pub spent_window_start: u64,
    pub spent_near: U128,
    pub spent_usdc: U128,
    /// Chain-signatures derivation path + derived foreign address (e.g. EVM) for cross-chain payouts.
    pub chainsig_path: Option<String>,
    pub foreign_address: Option<String>,
    pub created_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Bid {
    pub token_id: TokenId,
    pub price: U128,
    pub pitch: String,
    pub at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Flag {
    pub by: TokenId,
    pub severity: u8,
    pub reason: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub client: AccountId,
    pub title: String,
    /// Plaintext spec, or ciphertext for private jobs (plaintext only ever seen inside TEE inference).
    pub spec: String,
    pub private: bool,
    pub skill: String,
    pub asset: Asset,
    pub budget: U128,
    pub price: U128,
    pub min_reputation: u32,
    pub min_stake: U128,
    pub status: JobStatus,
    pub bids: Vec<Bid>,
    pub assignee: Option<TokenId>,
    pub collaborators: Vec<(TokenId, u16)>,
    pub result: Option<String>,
    pub result_hash: Option<String>,
    pub attestation: Option<String>,
    pub flags: Vec<Flag>,
    pub rating: Option<u8>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Event {
    pub idx: u64,
    pub ts: u64,
    pub kind: String,
    pub actor: AccountId,
    pub job: Option<u64>,
    pub token_id: Option<TokenId>,
    pub amount: Option<U128>,
    pub asset: Option<Asset>,
    pub text: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Stream {
    pub id: u64,
    pub recipient: AccountId,
    pub asset: Asset,
    pub amount_per_period: U128,
    pub period_ms: u64,
    pub periods: u32,
    pub start: u64,
    pub claimed: U128,
    pub memo: String,
    pub active: bool,
}

#[near(serializers = [json])]
pub struct Stats {
    pub owner: AccountId,
    pub admin: Option<AccountId>,
    pub honey: AccountId,
    pub usdc: AccountId,
    pub fee_bps: u16,
    pub charters: u64,
    pub jobs: u64,
    pub jobs_completed: u64,
    pub jobs_disputed: u64,
    pub jobs_flagged: u64,
    pub volume_near: U128,
    pub volume_usdc: U128,
    pub treasury_near: U128,
    pub treasury_usdc: U128,
    pub reserved_near: U128,
    pub reserved_usdc: U128,
    pub honey_minted: U128,
    pub honey_slashed: U128,
    pub honey_epoch: u64,
    pub honey_reward_now: U128,
    pub events: u64,
    pub streams: u64,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum FtMsg {
    /// Post a job paid in stablecoin: `{"post_job": {...}}`
    PostJob {
        title: String,
        spec: String,
        private: Option<bool>,
        skill: String,
        min_reputation: Option<u32>,
        min_stake: Option<U128>,
    },
    /// Stake HONEY on a charter: `{"stake": {"token_id": "1"}}`
    Stake { token_id: TokenId },
    /// Top up the treasury: `{"donate": {}}`
    Donate {},
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Hive {
    owner: AccountId,
    admin: Option<AccountId>,
    honey: AccountId,
    usdc: AccountId,
    fee_bps: u16,
    nft: NonFungibleToken,
    charters: LookupMap<TokenId, Charter>,
    agent_index: LookupMap<AccountId, TokenId>,
    next_charter: u64,
    jobs: LookupMap<u64, Job>,
    next_job: u64,
    events: Vector<Event>,
    streams: Vector<Stream>,
    jobs_completed: u64,
    jobs_disputed: u64,
    jobs_flagged: u64,
    volume_near: u128,
    volume_usdc: u128,
    treasury_near: u128,
    treasury_usdc: u128,
    reserved_near: u128,
    reserved_usdc: u128,
    honey_minted: u128,
    honey_slashed: u128,
}

fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

/// Human-readable amount for event text: NEAR with 4 decimals, hUSDC with 2.
fn fmt_amount(asset: Asset, v: u128) -> String {
    match asset {
        Asset::Near => {
            let milli = v / 10u128.pow(20); // 1e-4 NEAR units
            format!("{}.{:04} NEAR", milli / 10_000, milli % 10_000)
        }
        Asset::Usdc => format!("{}.{:02} hUSDC", v / 1_000_000, (v % 1_000_000) / 10_000),
    }
}

fn svg_escape(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-' || *c == '_' || *c == '.')
        .collect()
}

pub fn level_of(rep: u32, jobs: u32) -> u32 {
    // Level grows with completed jobs, gated by reputation.
    let by_jobs = match jobs {
        0..=1 => 1,
        2..=4 => 2,
        5..=9 => 3,
        10..=19 => 4,
        20..=39 => 5,
        _ => 6,
    };
    let cap = 1 + rep / 150;
    by_jobs.min(cap).max(1)
}

#[near]
impl Hive {
    #[init]
    pub fn new(owner: AccountId, honey: AccountId, usdc: AccountId, fee_bps: u16) -> Self {
        require!(fee_bps <= 2_000, "fee too high");
        let me = env::current_account_id();
        Self {
            owner,
            admin: Some(env::predecessor_account_id()),
            honey,
            usdc,
            fee_bps,
            nft: NonFungibleToken::new(
                StorageKey::NftOwner,
                me,
                Some(StorageKey::NftMeta),
                Some(StorageKey::NftEnum),
                None::<StorageKey>,
            ),
            charters: LookupMap::new(StorageKey::Charters),
            agent_index: LookupMap::new(StorageKey::AgentIndex),
            next_charter: 1,
            jobs: LookupMap::new(StorageKey::Jobs),
            next_job: 1,
            events: Vector::new(StorageKey::Events),
            streams: Vector::new(StorageKey::Streams),
            jobs_completed: 0,
            jobs_disputed: 0,
            jobs_flagged: 0,
            volume_near: 0,
            volume_usdc: 0,
            treasury_near: 0,
            treasury_usdc: 0,
            reserved_near: 0,
            reserved_usdc: 0,
            honey_minted: 0,
            honey_slashed: 0,
        }
    }

    // ───────────────────────────── internal helpers ─────────────────────────────

    fn is_council(&self, who: &AccountId) -> bool {
        *who == self.owner || self.admin.as_ref() == Some(who)
    }

    fn assert_council(&self) {
        require!(self.is_council(&env::predecessor_account_id()), "council (DAO) only");
    }

    fn log_event(
        &mut self,
        kind: &str,
        job: Option<u64>,
        token_id: Option<TokenId>,
        amount: Option<u128>,
        asset: Option<Asset>,
        text: String,
    ) {
        let ev = Event {
            idx: self.events.len() as u64,
            ts: env::block_timestamp_ms(),
            kind: kind.to_string(),
            actor: env::predecessor_account_id(),
            job,
            token_id,
            amount: amount.map(U128),
            asset,
            text: short(&text, MAX_EVENTS_TEXT),
        };
        // NEP-297 style log so indexers can follow the economy too.
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"hivemind\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
            kind,
            serde_json::to_string(&ev).unwrap_or_default()
        ));
        self.events.push(ev);
    }

    fn charter(&self, token_id: &TokenId) -> Charter {
        self.charters.get(token_id).cloned().unwrap_or_else(|| env::panic_str("no such charter"))
    }

    fn job(&self, id: u64) -> Job {
        self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such job"))
    }

    fn nft_owner(&self, token_id: &TokenId) -> AccountId {
        self.nft.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("no such token"))
    }

    fn assert_agent(&self, token_id: &TokenId) -> Charter {
        let c = self.charter(token_id);
        require!(env::predecessor_account_id() == c.agent, "only the chartered agent account");
        require!(!c.frozen, "charter frozen by policy");
        c
    }

    fn pay_out(&self, to: AccountId, asset: Asset, amount: u128, memo: &str) {
        if amount == 0 {
            return;
        }
        match asset {
            Asset::Near => {
                let _ = Promise::new(to).transfer(NearToken::from_yoctonear(amount));
            }
            Asset::Usdc => {
                let _ = ext_ft::ext(self.usdc.clone())
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(FT_GAS)
                    .ft_transfer(to, U128(amount), Some(memo.to_string()));
            }
        }
    }

    fn honey_reward_now(&self) -> u128 {
        let epoch = self.jobs_completed / HALVING_EVERY;
        if epoch >= 20 {
            ONE_HONEY
        } else {
            (BASE_REWARD >> epoch).max(ONE_HONEY)
        }
    }

    fn render_svg(c: &Charter) -> String {
        let level = level_of(c.reputation, c.jobs_done);
        let palette = ["#f5b700", "#f59e0b", "#f97316", "#ef4444", "#a855f7", "#3b82f6", "#10b981"];
        let color = if c.frozen { "#6b7280" } else { palette[(level as usize) % palette.len()] };
        let rings: String = (0..level)
            .map(|i| {
                let r = 70 + i * 9;
                format!("<circle cx='150' cy='130' r='{}' fill='none' stroke='{}' stroke-opacity='{}' stroke-width='2'/>", r, color, 0.9 - (i as f32) * 0.12)
            })
            .collect();
        let name = svg_escape(&c.name);
        let skills = svg_escape(&c.skills.join(" . "));
        format!(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'><rect width='300' height='300' fill='#14110a'/>{rings}<polygon points='150,70 202,100 202,160 150,190 98,160 98,100' fill='{color}'/><text x='150' y='142' font-family='monospace' font-size='34' text-anchor='middle' fill='#14110a'>L{level}</text><text x='150' y='232' font-family='monospace' font-size='20' text-anchor='middle' fill='#fff'>{name}</text><text x='150' y='254' font-family='monospace' font-size='11' text-anchor='middle' fill='#d4c9a8'>{skills}</text><text x='150' y='278' font-family='monospace' font-size='11' text-anchor='middle' fill='{color}'>REP {rep} . JOBS {jobs}{frozen}</text></svg>",
            rings = rings,
            color = color,
            level = level,
            name = name,
            skills = skills,
            rep = c.reputation,
            jobs = c.jobs_done,
            frozen = if c.frozen { " . FROZEN" } else { "" }
        )
    }

    fn refresh_metadata(&mut self, c: &Charter) {
        let meta = Self::build_metadata(c);
        if let Some(m) = self.nft.token_metadata_by_id.as_mut() {
            m.insert(&c.token_id, &meta);
        }
    }

    fn build_metadata(c: &Charter) -> TokenMetadata {
        let svg = Self::render_svg(c);
        let level = level_of(c.reputation, c.jobs_done);
        let meta = TokenMetadata {
            title: Some(format!("Hivemind Charter #{} — {}", c.token_id, c.name)),
            description: Some(format!(
                "AI agent {} ({}). Level {}, reputation {}, {} jobs done. This NFT owns the agent's treasury: {} yoctoNEAR + {} USDC units.",
                c.agent, c.skills.join(", "), level, c.reputation, c.jobs_done, c.bal_near.0, c.bal_usdc.0
            )),
            media: Some(format!("data:image/svg+xml;utf8,{}", svg.replace('#', "%23"))),
            media_hash: None,
            copies: Some(1),
            issued_at: Some(c.created_at.to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: Some(env::block_timestamp_ms().to_string()),
            extra: Some(
                serde_json::json!({
                    "agent": c.agent, "level": level, "reputation": c.reputation,
                    "jobs_done": c.jobs_done, "skills": c.skills, "frozen": c.frozen,
                    "foreign_address": c.foreign_address,
                })
                .to_string(),
            ),
            reference: None,
            reference_hash: None,
        };
        meta
    }

    fn roll_window(c: &mut Charter) {
        let now = env::block_timestamp_ms();
        if now - c.spent_window_start >= DAY_MS {
            c.spent_window_start = now;
            c.spent_near = U128(0);
            c.spent_usdc = U128(0);
        }
    }

    fn create_job(
        &mut self,
        client: AccountId,
        title: String,
        spec: String,
        private: bool,
        skill: String,
        asset: Asset,
        budget: u128,
        min_reputation: u32,
        min_stake: u128,
    ) -> u64 {
        require!(budget > 0, "budget required");
        require!(title.len() <= 140 && spec.len() <= 4000, "title/spec too long");
        let id = self.next_job;
        self.next_job += 1;
        let now = env::block_timestamp_ms();
        let job = Job {
            id,
            client: client.clone(),
            title: title.clone(),
            spec,
            private,
            skill,
            asset,
            budget: U128(budget),
            price: U128(0),
            min_reputation,
            min_stake: U128(min_stake),
            status: JobStatus::Open,
            bids: vec![],
            assignee: None,
            collaborators: vec![],
            result: None,
            result_hash: None,
            attestation: None,
            flags: vec![],
            rating: None,
            created_at: now,
            updated_at: now,
        };
        self.jobs.insert(id, job);
        self.log_event(
            "job_posted",
            Some(id),
            None,
            Some(budget),
            Some(asset),
            format!("{} posted{} job: {}", client, if private { " a private" } else { "" }, title),
        );
        id
    }

    fn settle(&mut self, mut job: Job, rating: u8) -> Job {
        let price = job.price.0;
        let fee = price * self.fee_bps as u128 / 10_000;
        let mut remaining = price - fee;
        let asset = job.asset;
        match asset {
            Asset::Near => {
                self.treasury_near += fee;
                self.volume_near += price;
            }
            Asset::Usdc => {
                self.treasury_usdc += fee;
                self.volume_usdc += price;
            }
        }
        let reward = self.honey_reward_now() * rating as u128 / 5;
        let assignee = job.assignee.clone().unwrap();
        let mut honey_mints: Vec<(AccountId, u128)> = vec![];
        let distributable = remaining;
        for (tid, bps) in job.collaborators.clone() {
            let share = distributable * bps as u128 / 10_000;
            remaining -= share;
            let mut c = self.charter(&tid);
            match asset {
                Asset::Near => {
                    c.bal_near = U128(c.bal_near.0 + share);
                    c.earned_near = U128(c.earned_near.0 + share);
                }
                Asset::Usdc => {
                    c.bal_usdc = U128(c.bal_usdc.0 + share);
                    c.earned_usdc = U128(c.earned_usdc.0 + share);
                }
            }
            c.jobs_done += 1;
            c.reputation = (c.reputation + 5 * rating as u32 / 2).min(1000);
            let h = reward * bps as u128 / 10_000;
            c.honey_earned = U128(c.honey_earned.0 + h);
            honey_mints.push((c.agent.clone(), h));
            self.charters.insert(tid.clone(), c.clone());
            self.refresh_metadata(&c);
        }
        let mut c = self.charter(&assignee);
        match asset {
            Asset::Near => {
                c.bal_near = U128(c.bal_near.0 + remaining);
                c.earned_near = U128(c.earned_near.0 + remaining);
            }
            Asset::Usdc => {
                c.bal_usdc = U128(c.bal_usdc.0 + remaining);
                c.earned_usdc = U128(c.earned_usdc.0 + remaining);
            }
        }
        c.jobs_done += 1;
        // rating 5 → +25, 3 → +5, 1 → -15
        let delta: i64 = (rating as i64 - 2) * 10 - 5;
        c.reputation = ((c.reputation as i64 + delta).clamp(0, 1000)) as u32;
        let collab_honey: u128 = honey_mints.iter().map(|(_, h)| *h).sum();
        let mine = reward - collab_honey;
        c.honey_earned = U128(c.honey_earned.0 + mine);
        honey_mints.push((c.agent.clone(), mine));
        self.charters.insert(assignee.clone(), c.clone());
        self.refresh_metadata(&c);

        for (acc, amt) in honey_mints {
            if amt > 0 {
                self.honey_minted += amt;
                let _ = ext_ft::ext(self.honey.clone())
                    .with_static_gas(FT_GAS)
                    .mint(acc, U128(amt), Some(format!("job #{}", job.id)));
            }
        }
        self.jobs_completed += 1;
        job.status = JobStatus::Completed;
        job.rating = Some(rating);
        job.updated_at = env::block_timestamp_ms();
        self.log_event(
            "job_completed",
            Some(job.id),
            Some(assignee),
            Some(price),
            Some(asset),
            format!(
                "#{} paid {} to {} (rating {}/5, fee {} to treasury, {} HONEY minted)",
                job.id,
                fmt_amount(asset, price),
                c.name,
                rating,
                fmt_amount(asset, fee),
                reward / ONE_HONEY
            ),
        );
        job
    }

    // ───────────────────────────── charters ─────────────────────────────

    /// Charter a new AI agent. The NFT goes to `owner_id` (the human/org operating the agent);
    /// `agent` is the account the agent runtime signs with (ideally a function-call key only).
    #[payable]
    pub fn mint_charter(
        &mut self,
        agent: AccountId,
        name: String,
        skills: Vec<String>,
        persona: String,
        owner_id: Option<AccountId>,
    ) -> TokenId {
        require!(
            env::attached_deposit() >= NearToken::from_millinear(50),
            "attach 0.05 NEAR for charter storage"
        );
        require!(self.agent_index.get(&agent).is_none(), "agent already chartered");
        require!(name.len() <= 24 && !name.is_empty(), "name 1-24 chars");
        require!(skills.len() <= 5, "max 5 skills");
        let owner_id = owner_id.unwrap_or_else(env::predecessor_account_id);
        let token_id = self.next_charter.to_string();
        self.next_charter += 1;
        let now = env::block_timestamp_ms();
        let c = Charter {
            token_id: token_id.clone(),
            agent: agent.clone(),
            name: name.clone(),
            skills,
            persona: short(&persona, 400),
            reputation: 500,
            jobs_done: 0,
            jobs_failed: 0,
            bal_near: U128(0),
            bal_usdc: U128(0),
            earned_near: U128(0),
            earned_usdc: U128(0),
            honey_staked: U128(0),
            honey_earned: U128(0),
            policy: Policy {
                max_bid: U128(5 * 10u128.pow(24)),
                daily_limit_near: U128(2 * 10u128.pow(24)),
                daily_limit_usdc: U128(500_000_000),
                payout_to: None,
                allow_hire: true,
                max_collab_bps: 4_000,
            },
            frozen: false,
            spent_window_start: now,
            spent_near: U128(0),
            spent_usdc: U128(0),
            chainsig_path: None,
            foreign_address: None,
            created_at: now,
        };
        self.nft.internal_mint_with_refund(token_id.clone(), owner_id.clone(), Some(Self::build_metadata(&c)), None);
        self.charters.insert(token_id.clone(), c.clone());
        self.agent_index.insert(agent.clone(), token_id.clone());
        self.log_event(
            "charter_minted",
            None,
            Some(token_id.clone()),
            None,
            None,
            format!("{} chartered agent {} ({}) for {}", owner_id, name, agent, c.skills.join("/")),
        );
        token_id
    }

    /// NFT owner (or council) sets the agent's spend policy.
    pub fn set_policy(&mut self, token_id: TokenId, policy: Policy) {
        let who = env::predecessor_account_id();
        require!(who == self.nft_owner(&token_id) || self.is_council(&who), "charter owner only");
        require!(policy.max_collab_bps <= 9_000, "max_collab_bps <= 90%");
        let mut c = self.charter(&token_id);
        c.policy = policy;
        self.charters.insert(token_id.clone(), c);
        self.log_event("policy_set", None, Some(token_id), None, None, "spend policy updated".into());
    }

    /// Freeze / unfreeze an agent. Charter owner or council (circuit breaker).
    pub fn set_frozen(&mut self, token_id: TokenId, frozen: bool, reason: String) {
        let who = env::predecessor_account_id();
        require!(who == self.nft_owner(&token_id) || self.is_council(&who), "charter owner or council");
        let mut c = self.charter(&token_id);
        c.frozen = frozen;
        self.charters.insert(token_id.clone(), c.clone());
        self.refresh_metadata(&c);
        self.log_event(
            if frozen { "agent_frozen" } else { "agent_unfrozen" },
            None,
            Some(token_id),
            None,
            None,
            format!("{}: {}", c.name, reason),
        );
    }

    /// Record the agent's chain-signatures path and derived foreign (e.g. EVM) payout address.
    pub fn set_foreign_address(&mut self, token_id: TokenId, path: String, address: String) {
        let who = env::predecessor_account_id();
        let mut c = self.charter(&token_id);
        require!(who == c.agent || who == self.nft_owner(&token_id), "agent or owner");
        require!(path.len() <= 64 && address.len() <= 128, "too long");
        c.chainsig_path = Some(path);
        c.foreign_address = Some(address.clone());
        self.charters.insert(token_id.clone(), c.clone());
        self.refresh_metadata(&c);
        self.log_event("chainsig_address", None, Some(token_id), None, None, format!("{} cross-chain address {}", c.name, address));
    }

    /// Charter owner withdraws the agent's earnings, enforced by the policy engine.
    pub fn withdraw(&mut self, token_id: TokenId, asset: Asset, amount: U128) {
        let who = env::predecessor_account_id();
        let owner = self.nft_owner(&token_id);
        require!(who == owner, "only the NFT owner can withdraw the agent treasury");
        let mut c = self.charter(&token_id);
        require!(!c.frozen, "charter frozen");
        Self::roll_window(&mut c);
        let to = c.policy.payout_to.clone().unwrap_or(owner);
        match asset {
            Asset::Near => {
                require!(c.bal_near.0 >= amount.0, "insufficient agent balance");
                require!(c.spent_near.0 + amount.0 <= c.policy.daily_limit_near.0, "policy: daily NEAR limit");
                c.bal_near = U128(c.bal_near.0 - amount.0);
                c.spent_near = U128(c.spent_near.0 + amount.0);
            }
            Asset::Usdc => {
                require!(c.bal_usdc.0 >= amount.0, "insufficient agent balance");
                require!(c.spent_usdc.0 + amount.0 <= c.policy.daily_limit_usdc.0, "policy: daily USDC limit");
                c.bal_usdc = U128(c.bal_usdc.0 - amount.0);
                c.spent_usdc = U128(c.spent_usdc.0 + amount.0);
            }
        }
        self.charters.insert(token_id.clone(), c.clone());
        self.refresh_metadata(&c);
        self.pay_out(to.clone(), asset, amount.0, "hivemind withdraw");
        self.log_event("withdraw", None, Some(token_id), Some(amount.0), Some(asset), format!("{} withdrew to {}", c.name, to));
    }

    // ───────────────────────────── job market ─────────────────────────────

    /// Post a job paid in NEAR (attached deposit = budget). Stablecoin jobs use `ft_transfer_call`.
    #[payable]
    pub fn post_job(
        &mut self,
        title: String,
        spec: String,
        private: Option<bool>,
        skill: String,
        min_reputation: Option<u32>,
        min_stake: Option<U128>,
    ) -> u64 {
        let budget = env::attached_deposit().as_yoctonear();
        require!(budget >= 10u128.pow(22), "min budget 0.01 NEAR");
        self.create_job(
            env::predecessor_account_id(),
            title,
            spec,
            private.unwrap_or(false),
            skill,
            Asset::Near,
            budget,
            min_reputation.unwrap_or(0),
            min_stake.map(|s| s.0).unwrap_or(0),
        )
    }

    /// Sentinel agents (skill `security`) screen jobs for scams / prompt injection.
    /// Severity >= 3 blocks the job from bidding.
    pub fn flag_job(&mut self, job_id: u64, token_id: TokenId, severity: u8, reason: String) {
        let c = self.assert_agent(&token_id);
        require!(c.skills.iter().any(|s| s == "security"), "only security agents may flag");
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Open || job.status == JobStatus::Flagged, "job not open");
        require!(job.flags.iter().all(|f| f.by != token_id), "already flagged");
        job.flags.push(Flag { by: token_id.clone(), severity: severity.min(5), reason: short(&reason, 200) });
        if severity >= 3 && job.status == JobStatus::Open {
            job.status = JobStatus::Flagged;
            self.jobs_flagged += 1;
        }
        job.updated_at = env::block_timestamp_ms();
        let status = job.status.clone();
        self.jobs.insert(job_id, job);
        self.log_event(
            if status == JobStatus::Flagged { "job_blocked" } else { "job_screened" },
            Some(job_id),
            Some(token_id),
            None,
            None,
            format!("{} screened #{} (severity {}): {}", c.name, job_id, severity, reason),
        );
    }

    pub fn bid(&mut self, job_id: u64, token_id: TokenId, price: U128, pitch: String) {
        let c = self.assert_agent(&token_id);
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Open, "job not open for bids");
        require!(job.client != c.agent, "cannot bid on own job");
        require!(price.0 > 0 && price.0 <= job.budget.0, "price must be within budget");
        require!(c.reputation >= job.min_reputation, "reputation too low for this job");
        require!(c.honey_staked.0 >= job.min_stake.0, "stake more HONEY to bid on this job");
        if job.asset == Asset::Near {
            require!(job.budget.0 <= c.policy.max_bid.0, "policy: job too large for this agent");
        }
        require!(job.bids.len() < 12, "bid book full");
        job.bids.retain(|b| b.token_id != token_id);
        job.bids.push(Bid { token_id: token_id.clone(), price, pitch: short(&pitch, 280), at: env::block_timestamp_ms() });
        job.updated_at = env::block_timestamp_ms();
        let asset = job.asset;
        self.jobs.insert(job_id, job);
        self.log_event("bid", Some(job_id), Some(token_id), Some(price.0), Some(asset), format!("{} bid on #{}: {}", c.name, job_id, short(&pitch, 120)));
    }

    /// Client awards the job to a bidder; the unused budget is refunded immediately.
    pub fn award(&mut self, job_id: u64, token_id: TokenId) {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.client, "client only");
        require!(job.status == JobStatus::Open, "job not open");
        let bid = job.bids.iter().find(|b| b.token_id == token_id).cloned().unwrap_or_else(|| env::panic_str("no such bid"));
        let c = self.charter(&token_id);
        require!(!c.frozen, "agent frozen");
        job.assignee = Some(token_id.clone());
        job.price = bid.price;
        job.status = JobStatus::Assigned;
        job.updated_at = env::block_timestamp_ms();
        let refund = job.budget.0 - bid.price.0;
        let (client, asset) = (job.client.clone(), job.asset);
        self.jobs.insert(job_id, job);
        self.pay_out(client, asset, refund, "hivemind budget refund");
        self.log_event("awarded", Some(job_id), Some(token_id), Some(bid.price.0), Some(asset), format!("#{} awarded to {}", job_id, c.name));
    }

    /// The assignee hires another agent for a revenue share (agents hiring agents).
    pub fn add_collaborator(&mut self, job_id: u64, token_id: TokenId, collaborator: TokenId, share_bps: u16) {
        let c = self.assert_agent(&token_id);
        require!(c.policy.allow_hire, "policy: hiring disabled");
        let mut job = self.job(job_id);
        require!(job.assignee.as_ref() == Some(&token_id), "assignee only");
        require!(job.status == JobStatus::Assigned, "job not in progress");
        require!(collaborator != token_id, "cannot hire yourself");
        let col = self.charter(&collaborator);
        require!(!col.frozen, "collaborator frozen");
        let total: u32 = job.collaborators.iter().filter(|(t, _)| *t != collaborator).map(|(_, b)| *b as u32).sum::<u32>() + share_bps as u32;
        require!(total <= c.policy.max_collab_bps as u32, "policy: revenue share cap exceeded");
        job.collaborators.retain(|(t, _)| *t != collaborator);
        job.collaborators.push((collaborator.clone(), share_bps));
        self.jobs.insert(job_id, job);
        self.log_event("hired", Some(job_id), Some(collaborator), None, None, format!("{} hired {} for {}% of #{}", c.name, col.name, share_bps / 100, job_id));
    }

    pub fn submit(&mut self, job_id: u64, token_id: TokenId, result: String, result_hash: String, attestation: Option<String>) {
        let c = self.assert_agent(&token_id);
        let mut job = self.job(job_id);
        require!(job.assignee.as_ref() == Some(&token_id), "assignee only");
        require!(job.status == JobStatus::Assigned, "job not in progress");
        require!(result.len() <= 6000, "result too long; store off-chain and submit a URI");
        job.result = Some(result);
        job.result_hash = Some(result_hash);
        job.attestation = attestation.clone();
        job.status = JobStatus::Submitted;
        job.updated_at = env::block_timestamp_ms();
        self.jobs.insert(job_id, job);
        self.log_event(
            "submitted",
            Some(job_id),
            Some(token_id),
            None,
            None,
            format!("{} delivered #{}{}", c.name, job_id, if attestation.is_some() { " with TEE attestation" } else { "" }),
        );
    }

    /// Client approves and rates (1-5). Pays agent(s), fee to treasury, mints HONEY.
    pub fn approve(&mut self, job_id: u64, rating: u8) {
        let job = self.job(job_id);
        require!(env::predecessor_account_id() == job.client, "client only");
        require!(job.status == JobStatus::Submitted, "nothing to approve");
        require!((1..=5).contains(&rating), "rating 1-5");
        let job = self.settle(job, rating);
        self.jobs.insert(job_id, job);
    }

    pub fn dispute(&mut self, job_id: u64, reason: String) {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.client, "client only");
        require!(job.status == JobStatus::Submitted || job.status == JobStatus::Assigned, "cannot dispute now");
        job.status = JobStatus::Disputed;
        job.updated_at = env::block_timestamp_ms();
        self.jobs_disputed += 1;
        self.jobs.insert(job_id, job);
        self.log_event("disputed", Some(job_id), None, None, None, short(&reason, 200));
    }

    /// Council (DAO) resolves a dispute: refund the client (and slash the agent) or pay the agent.
    pub fn resolve(&mut self, job_id: u64, refund_client: bool) {
        self.assert_council();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Disputed, "not disputed");
        if refund_client {
            let tid = job.assignee.clone().unwrap();
            let mut c = self.charter(&tid);
            c.jobs_failed += 1;
            c.reputation = c.reputation.saturating_sub(100);
            let slash = c.honey_staked.0 / 2;
            c.honey_staked = U128(c.honey_staked.0 - slash);
            self.charters.insert(tid.clone(), c.clone());
            self.refresh_metadata(&c);
            if slash > 0 {
                self.honey_slashed += slash;
                let _ = ext_ft::ext(self.honey.clone()).with_static_gas(FT_GAS).burn(U128(slash), Some(format!("slash job #{}", job_id)));
            }
            self.pay_out(job.client.clone(), job.asset, job.price.0, "hivemind dispute refund");
            job.status = JobStatus::Refunded;
            job.updated_at = env::block_timestamp_ms();
            self.log_event("slashed", Some(job_id), Some(tid), Some(slash), None, format!("{} lost dispute on #{}: -100 rep, {} HONEY burned", c.name, job_id, slash / ONE_HONEY));
        } else {
            job = self.settle(job, 3);
        }
        self.jobs.insert(job_id, job);
    }

    pub fn cancel(&mut self, job_id: u64) {
        let mut job = self.job(job_id);
        let who = env::predecessor_account_id();
        require!(who == job.client || (job.status == JobStatus::Flagged && self.is_council(&who)), "client only");
        require!(job.status == JobStatus::Open || job.status == JobStatus::Flagged, "cannot cancel now");
        job.status = JobStatus::Cancelled;
        let (client, asset, budget) = (job.client.clone(), job.asset, job.budget.0);
        self.jobs.insert(job_id, job);
        self.pay_out(client, asset, budget, "hivemind job cancelled");
        self.log_event("cancelled", Some(job_id), None, Some(budget), Some(asset), format!("#{} cancelled and refunded", job_id));
    }

    /// Unstake HONEY (only when the agent has no job in dispute; simplified: owner-only, not frozen).
    pub fn unstake(&mut self, token_id: TokenId, amount: U128) {
        let who = env::predecessor_account_id();
        require!(who == self.nft_owner(&token_id), "charter owner only");
        let mut c = self.charter(&token_id);
        require!(!c.frozen, "frozen");
        require!(c.honey_staked.0 >= amount.0, "not enough staked");
        c.honey_staked = U128(c.honey_staked.0 - amount.0);
        self.charters.insert(token_id.clone(), c);
        let _ = ext_ft::ext(self.honey.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_GAS)
            .ft_transfer(who, amount, Some("unstake".into()));
        self.log_event("unstaked", None, Some(token_id), Some(amount.0), None, "HONEY unstaked".into());
    }

    // ───────────────────────────── treasury / council ─────────────────────────────

    /// Agents with the `treasury` skill publish treasury plans (e.g. NEAR Intents 1Click quotes).
    pub fn log_treasury_plan(&mut self, token_id: TokenId, plan: String) {
        let c = self.assert_agent(&token_id);
        require!(c.skills.iter().any(|s| s == "treasury"), "treasury agents only");
        self.log_event("treasury_plan", None, Some(token_id), None, None, plan);
    }

    #[payable]
    pub fn donate(&mut self) {
        let amt = env::attached_deposit().as_yoctonear();
        self.treasury_near += amt;
        self.log_event("donation", None, None, Some(amt), Some(Asset::Near), "treasury top-up".into());
    }

    pub fn set_fee(&mut self, fee_bps: u16) {
        self.assert_council();
        require!(fee_bps <= 2_000, "fee too high");
        self.fee_bps = fee_bps;
        self.log_event("fee_set", None, None, None, None, format!("protocol fee now {} bps", fee_bps));
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_council();
        self.owner = owner.clone();
        self.log_event("owner_set", None, None, None, None, format!("council is now {}", owner));
    }

    /// Bootstrap admin steps down; from here only the DAO governs.
    pub fn renounce_admin(&mut self) {
        require!(self.admin.as_ref() == Some(&env::predecessor_account_id()), "admin only");
        self.admin = None;
        self.log_event("admin_renounced", None, None, None, None, "bootstrap admin renounced; DAO only".into());
    }

    pub fn grant(&mut self, recipient: AccountId, asset: Asset, amount: U128, memo: String) {
        self.assert_council();
        match asset {
            Asset::Near => {
                require!(self.treasury_near >= amount.0, "treasury too small");
                self.treasury_near -= amount.0;
            }
            Asset::Usdc => {
                require!(self.treasury_usdc >= amount.0, "treasury too small");
                self.treasury_usdc -= amount.0;
            }
        }
        self.pay_out(recipient.clone(), asset, amount.0, "hivemind grant");
        self.log_event("grant", None, None, Some(amount.0), Some(asset), format!("grant to {}: {}", recipient, short(&memo, 120)));
    }

    /// Payroll: council streams treasury funds to a (human) contributor over `periods`.
    pub fn create_stream(&mut self, recipient: AccountId, asset: Asset, amount_per_period: U128, period_ms: u64, periods: u32, memo: String) -> u64 {
        self.assert_council();
        require!(period_ms >= 60_000 && periods > 0 && periods <= 520, "bad schedule");
        let total = amount_per_period.0 * periods as u128;
        match asset {
            Asset::Near => {
                require!(self.treasury_near >= total, "treasury too small");
                self.treasury_near -= total;
                self.reserved_near += total;
            }
            Asset::Usdc => {
                require!(self.treasury_usdc >= total, "treasury too small");
                self.treasury_usdc -= total;
                self.reserved_usdc += total;
            }
        }
        let id = self.streams.len() as u64;
        self.streams.push(Stream {
            id,
            recipient: recipient.clone(),
            asset,
            amount_per_period,
            period_ms,
            periods,
            start: env::block_timestamp_ms(),
            claimed: U128(0),
            memo: short(&memo, 120),
            active: true,
        });
        self.log_event("stream_created", None, None, Some(total), Some(asset), format!("payroll stream #{} to {}: {}", id, recipient, short(&memo, 80)));
        id
    }

    pub fn claim_stream(&mut self, stream_id: u64) -> U128 {
        let mut s = self.streams.get(stream_id as u32).cloned().unwrap_or_else(|| env::panic_str("no stream"));
        require!(env::predecessor_account_id() == s.recipient, "recipient only");
        let elapsed = (env::block_timestamp_ms() - s.start) / s.period_ms;
        let vested = s.amount_per_period.0 * (elapsed.min(s.periods as u64) as u128);
        let due = vested - s.claimed.0;
        require!(due > 0, "nothing vested yet");
        s.claimed = U128(s.claimed.0 + due);
        match s.asset {
            Asset::Near => self.reserved_near -= due,
            Asset::Usdc => self.reserved_usdc -= due,
        }
        let (to, asset) = (s.recipient.clone(), s.asset);
        self.streams.replace(stream_id as u32, s);
        self.pay_out(to.clone(), asset, due, "hivemind payroll");
        self.log_event("payroll_claimed", None, None, Some(due), Some(asset), format!("{} claimed payroll stream #{}", to, stream_id));
        U128(due)
    }

    // ───────────────────────────── views ─────────────────────────────

    pub fn get_stats(&self) -> Stats {
        Stats {
            owner: self.owner.clone(),
            admin: self.admin.clone(),
            honey: self.honey.clone(),
            usdc: self.usdc.clone(),
            fee_bps: self.fee_bps,
            charters: self.next_charter - 1,
            jobs: self.next_job - 1,
            jobs_completed: self.jobs_completed,
            jobs_disputed: self.jobs_disputed,
            jobs_flagged: self.jobs_flagged,
            volume_near: U128(self.volume_near),
            volume_usdc: U128(self.volume_usdc),
            treasury_near: U128(self.treasury_near),
            treasury_usdc: U128(self.treasury_usdc),
            reserved_near: U128(self.reserved_near),
            reserved_usdc: U128(self.reserved_usdc),
            honey_minted: U128(self.honey_minted),
            honey_slashed: U128(self.honey_slashed),
            honey_epoch: self.jobs_completed / HALVING_EVERY,
            honey_reward_now: U128(self.honey_reward_now()),
            events: self.events.len() as u64,
            streams: self.streams.len() as u64,
        }
    }

    pub fn get_charter(&self, token_id: TokenId) -> Option<Charter> {
        self.charters.get(&token_id).cloned()
    }

    pub fn get_charter_by_agent(&self, agent: AccountId) -> Option<Charter> {
        self.agent_index.get(&agent).and_then(|t| self.charters.get(t).cloned())
    }

    pub fn get_charters(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Charter> {
        let from = from.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_charter).take(limit as usize).filter_map(|i| self.charters.get(&i.to_string()).cloned()).collect()
    }

    pub fn get_charter_svg(&self, token_id: TokenId) -> String {
        Self::render_svg(&self.charter(&token_id))
    }

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    /// Newest first.
    pub fn get_jobs(&self, before: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let end = before.unwrap_or(self.next_job).min(self.next_job);
        let limit = limit.unwrap_or(20).min(50);
        (1..end).rev().take(limit as usize).filter_map(|i| self.jobs.get(&i).cloned()).collect()
    }

    /// Jobs still accepting bids (scans the most recent `scan` jobs).
    pub fn get_open_jobs(&self, scan: Option<u64>) -> Vec<Job> {
        let scan = scan.unwrap_or(50).min(100);
        (1..self.next_job).rev().take(scan as usize).filter_map(|i| self.jobs.get(&i)).filter(|j| j.status == JobStatus::Open).cloned().collect()
    }

    pub fn get_events(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Event> {
        let len = self.events.len() as u64;
        let limit = limit.unwrap_or(50).min(100);
        let from = from.unwrap_or(len.saturating_sub(limit));
        (from..len).take(limit as usize).filter_map(|i| self.events.get(i as u32).cloned()).collect()
    }

    pub fn get_streams(&self) -> Vec<Stream> {
        self.streams.iter().cloned().collect()
    }
}

// ───────────────────────────── FT receiver (stablecoin jobs, HONEY staking) ─────────────────────────────

#[near]
impl FungibleTokenReceiver for Hive {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let parsed: FtMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad msg"));
        match parsed {
            FtMsg::PostJob { title, spec, private, skill, min_reputation, min_stake } => {
                require!(token == self.usdc, "jobs are paid in the hive stablecoin");
                self.create_job(sender_id, title, spec, private.unwrap_or(false), skill, Asset::Usdc, amount.0, min_reputation.unwrap_or(0), min_stake.map(|s| s.0).unwrap_or(0));
            }
            FtMsg::Stake { token_id } => {
                require!(token == self.honey, "stake HONEY only");
                let mut c = self.charter(&token_id);
                c.honey_staked = U128(c.honey_staked.0 + amount.0);
                self.charters.insert(token_id.clone(), c.clone());
                self.log_event("staked", None, Some(token_id), Some(amount.0), None, format!("{} staked {} HONEY", c.name, amount.0 / ONE_HONEY));
            }
            FtMsg::Donate {} => {
                require!(token == self.usdc, "donate stablecoin only");
                self.treasury_usdc += amount.0;
                self.log_event("donation", None, None, Some(amount.0), Some(Asset::Usdc), format!("{} topped up the treasury", sender_id));
            }
        }
        PromiseOrValue::Value(U128(0))
    }
}

// ───────────────────────────── NEP-171 ─────────────────────────────

#[near]
impl NonFungibleTokenCore for Hive {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.nft.nft_transfer(receiver_id.clone(), token_id.clone(), approval_id, memo);
        self.log_event("charter_transferred", None, Some(token_id), None, None, format!("agent business transferred to {}", receiver_id));
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        self.nft.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.nft.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Hive {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        self.nft.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Hive {
    fn nft_total_supply(&self) -> U128 {
        self.nft.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.nft.nft_tokens(from_index, limit)
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.nft.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.nft.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Hive {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Hivemind Agent Charters".to_string(),
            symbol: "HIVE".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}

#[cfg(test)]
mod tests;
