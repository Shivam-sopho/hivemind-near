//! HONEY — a NEP-141 memecoin with mechanics.
//!
//! * Supply is **minted only by the Hive contract** when an AI agent completes paid work
//!   ("proof-of-labor"): no premine, no team allocation.
//! * Every wallet-to-wallet transfer **evaporates** `transfer_burn_bps` of the amount (burned forever).
//!   Transfers to/from the minter (the Hive) are exempt so staking & payouts stay exact.
//! * Holders can `burn` voluntarily (the Hive uses this to slash staked HONEY of agents that lose a dispute).
//!
//! The same WASM doubles as a **mock testnet stablecoin** (`faucet = true`, `transfer_burn_bps = 0`),
//! because NEAR testnet has no canonical USDC.
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Ft,
    Faucet,
}

#[near(serializers = [json])]
pub struct TokenStats {
    pub total_supply: U128,
    pub total_burned: U128,
    pub total_minted: U128,
    pub transfer_burn_bps: u16,
    pub minter: Option<AccountId>,
    pub faucet: bool,
    pub holders: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    token: FungibleToken,
    name: String,
    symbol: String,
    icon: Option<String>,
    decimals: u8,
    minter: Option<AccountId>,
    admin: AccountId,
    transfer_burn_bps: u16,
    faucet: bool,
    faucet_amount: u128,
    last_faucet: near_sdk::store::LookupMap<AccountId, u64>,
    total_burned: u128,
    total_minted: u128,
    holders: u64,
}

#[near]
impl Token {
    #[init]
    pub fn new(
        name: String,
        symbol: String,
        decimals: u8,
        icon: Option<String>,
        minter: Option<AccountId>,
        transfer_burn_bps: u16,
        faucet: bool,
        faucet_amount: Option<U128>,
    ) -> Self {
        require!(transfer_burn_bps <= 1000, "burn capped at 10%");
        Self {
            token: FungibleToken::new(StorageKey::Ft),
            name,
            symbol,
            icon,
            decimals,
            minter,
            admin: env::predecessor_account_id(),
            transfer_burn_bps,
            faucet,
            faucet_amount: faucet_amount.map(|a| a.0).unwrap_or(0),
            last_faucet: near_sdk::store::LookupMap::new(StorageKey::Faucet),
            total_burned: 0,
            total_minted: 0,
            holders: 0,
        }
    }

    /// One-time wiring of the minter (the Hive) by the deployer.
    pub fn set_minter(&mut self, minter: AccountId) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
        self.minter = Some(minter);
    }

    fn ensure_registered(&mut self, account_id: &AccountId) {
        if !self.token.accounts.contains_key(account_id) {
            // Testnet convenience: the token contract sponsors holder storage, so agents and
            // players never have to think about storage deposits ("players never notice the chain").
            self.token.internal_register_account(account_id);
            self.holders += 1;
        }
    }

    /// Mint — only callable by the Hive when work is approved.
    pub fn mint(&mut self, account_id: AccountId, amount: U128, memo: Option<String>) {
        require!(
            Some(env::predecessor_account_id()) == self.minter,
            "only the Hive can mint: HONEY is proof-of-labor"
        );
        self.ensure_registered(&account_id);
        self.token.internal_deposit(&account_id, amount.0);
        self.total_minted += amount.0;
        FtMint { owner_id: &account_id, amount, memo: memo.as_deref() }.emit();
    }

    /// Burn your own tokens (used by the Hive to slash dispute losers' stake).
    pub fn burn(&mut self, amount: U128, memo: Option<String>) {
        let account_id = env::predecessor_account_id();
        self.token.internal_withdraw(&account_id, amount.0);
        self.total_burned += amount.0;
        FtBurn { owner_id: &account_id, amount, memo: memo.as_deref() }.emit();
    }

    /// Testnet stablecoin faucet (only when `faucet = true`). One drip per account per hour.
    pub fn faucet_mint(&mut self) -> U128 {
        require!(self.faucet, "faucet disabled");
        let who = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        if let Some(last) = self.last_faucet.get(&who) {
            require!(now - *last > 3_600_000, "one drip per hour");
        }
        self.last_faucet.insert(who.clone(), now);
        self.ensure_registered(&who);
        self.token.internal_deposit(&who, self.faucet_amount);
        self.total_minted += self.faucet_amount;
        FtMint { owner_id: &who, amount: U128(self.faucet_amount), memo: Some("faucet") }.emit();
        U128(self.faucet_amount)
    }

    pub fn token_stats(&self) -> TokenStats {
        TokenStats {
            total_supply: U128(self.token.total_supply),
            total_burned: U128(self.total_burned),
            total_minted: U128(self.total_minted),
            transfer_burn_bps: self.transfer_burn_bps,
            minter: self.minter.clone(),
            faucet: self.faucet,
            holders: self.holders,
        }
    }

    fn evaporation(&self, sender: &AccountId, receiver: &AccountId, amount: u128) -> u128 {
        let exempt = self.minter.as_ref().map(|m| m == sender || m == receiver).unwrap_or(false);
        if exempt || self.transfer_burn_bps == 0 {
            0
        } else {
            amount * self.transfer_burn_bps as u128 / 10_000
        }
    }
}

#[near]
impl FungibleTokenCore for Token {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.ensure_registered(&receiver_id);
        let burn = self.evaporation(&sender, &receiver_id, amount.0);
        if burn > 0 {
            self.token.internal_withdraw(&sender, burn);
            self.total_burned += burn;
            FtBurn { owner_id: &sender, amount: U128(burn), memo: Some("evaporation") }.emit();
        }
        self.token.internal_transfer(&sender, &receiver_id, amount.0 - burn, memo);
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let sender = env::predecessor_account_id();
        self.ensure_registered(&receiver_id);
        let burn = self.evaporation(&sender, &receiver_id, amount.0);
        if burn > 0 {
            self.token.internal_withdraw(&sender, burn);
            self.total_burned += burn;
            FtBurn { owner_id: &sender, amount: U128(burn), memo: Some("evaporation") }.emit();
        }
        self.token.ft_transfer_call(receiver_id, U128(amount.0 - burn), memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Token {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            self.total_burned += burned;
        }
        used.into()
    }
}

#[near]
impl StorageManagement for Token {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Token {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            icon: self.icon.clone(),
            reference: None,
            reference_hash: None,
            decimals: self.decimals,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(pred: AccountId, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(pred).attached_deposit(NearToken::from_yoctonear(deposit));
        testing_env!(b.build());
    }

    #[test]
    fn mint_only_minter_and_evaporation() {
        ctx(accounts(0), 0);
        let mut t = Token::new("Honey".into(), "HONEY".into(), 18, None, Some(accounts(1)), 100, false, None);
        ctx(accounts(1), 0);
        t.mint(accounts(2), U128(10_000), None);
        assert_eq!(t.ft_balance_of(accounts(2)).0, 10_000);
        // wallet-to-wallet transfer burns 1%
        ctx(accounts(2), 1);
        t.ft_transfer(accounts(3), U128(1_000), None);
        assert_eq!(t.ft_balance_of(accounts(3)).0, 990);
        assert_eq!(t.ft_balance_of(accounts(2)).0, 9_000);
        assert_eq!(t.token_stats().total_burned.0, 10);
        assert_eq!(t.ft_total_supply().0, 9_990);
        // transfer to the minter (Hive) is exempt
        t.ft_transfer(accounts(1), U128(1_000), None);
        assert_eq!(t.ft_balance_of(accounts(1)).0, 1_000);
    }

    #[test]
    #[should_panic(expected = "only the Hive can mint")]
    fn non_minter_cannot_mint() {
        ctx(accounts(0), 0);
        let mut t = Token::new("Honey".into(), "HONEY".into(), 18, None, Some(accounts(1)), 100, false, None);
        ctx(accounts(2), 0);
        t.mint(accounts(2), U128(1), None);
    }

    #[test]
    fn faucet_works() {
        ctx(accounts(0), 0);
        let mut t = Token::new("USD Coin (mock)".into(), "USDC".into(), 6, None, None, 0, true, Some(U128(1_000_000_000)));
        ctx(accounts(2), 0);
        t.faucet_mint();
        assert_eq!(t.ft_balance_of(accounts(2)).0, 1_000_000_000);
    }
}
