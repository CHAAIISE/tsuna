//! DeFindex vault double: one asset, shares redeemable pro rata of the vault's balance.

use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub struct AssetStrategySet {
    pub address: Address,
    pub strategies: Vec<Address>,
}

#[contracttype]
#[derive(Clone)]
enum DfKey {
    Asset,
    Shares(Address),
    Total,
}

#[contract]
pub struct DeFindexMock;

impl DeFindexMock {
    fn managed(env: &Env) -> i128 {
        let asset: Address = env.storage().instance().get(&DfKey::Asset).unwrap();
        token::Client::new(env, &asset).balance(&env.current_contract_address())
    }

    fn total(env: &Env) -> i128 {
        env.storage().instance().get(&DfKey::Total).unwrap_or(0)
    }
}

#[contractimpl]
impl DeFindexMock {
    pub fn __constructor(env: Env, asset: Address) {
        env.storage().instance().set(&DfKey::Asset, &asset);
    }

    pub fn get_assets(env: Env) -> Vec<AssetStrategySet> {
        vec![
            &env,
            AssetStrategySet {
                address: env.storage().instance().get(&DfKey::Asset).unwrap(),
                strategies: Vec::new(&env),
            },
        ]
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .instance()
            .get(&DfKey::Shares(id))
            .unwrap_or(0)
    }

    pub fn get_asset_amounts_per_shares(env: Env, vault_shares: i128) -> Vec<i128> {
        let total = Self::total(&env);
        let amount = if total == 0 {
            0
        } else {
            vault_shares * Self::managed(&env) / total
        };
        vec![&env, amount]
    }

    /// Pulls the desired amount from `from` with `transfer`, as DeFindex does.
    pub fn deposit(
        env: Env,
        amounts_desired: Vec<i128>,
        _amounts_min: Vec<i128>,
        from: Address,
        _invest: bool,
    ) -> (Vec<i128>, i128) {
        from.require_auth();
        let amount = amounts_desired.get_unchecked(0);
        let (total, managed) = (Self::total(&env), Self::managed(&env));
        let minted = if total == 0 {
            amount
        } else {
            amount * total / managed
        };
        let asset: Address = env.storage().instance().get(&DfKey::Asset).unwrap();
        token::Client::new(&env, &asset).transfer(&from, env.current_contract_address(), &amount);
        let s = env.storage().instance();
        s.set(&DfKey::Total, &(total + minted));
        s.set(
            &DfKey::Shares(from.clone()),
            &(Self::balance(env.clone(), from) + minted),
        );
        (amounts_desired, minted)
    }

    pub fn withdraw(
        env: Env,
        withdraw_shares: i128,
        _min_amounts_out: Vec<i128>,
        from: Address,
    ) -> Vec<i128> {
        from.require_auth();
        let held = Self::balance(env.clone(), from.clone());
        assert!(withdraw_shares <= held);
        let total = Self::total(&env);
        let amount = withdraw_shares * Self::managed(&env) / total;
        let s = env.storage().instance();
        s.set(&DfKey::Total, &(total - withdraw_shares));
        s.set(&DfKey::Shares(from.clone()), &(held - withdraw_shares));
        let asset: Address = s.get(&DfKey::Asset).unwrap();
        token::Client::new(&env, &asset).transfer(&env.current_contract_address(), &from, &amount);
        vec![&env, amount]
    }
}
