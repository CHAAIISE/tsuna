//! Aquarius constant-product pool double with a separate LP share token it administers.

use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env, Symbol, Vec};

#[contracttype]
#[derive(Clone)]
enum PoolKey {
    Tokens,
    Share,
    Total,
}

#[contract]
pub struct AquariusMock;

impl AquariusMock {
    fn tokens(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&PoolKey::Tokens).unwrap()
    }

    fn reserve(env: &Env, index: u32) -> u128 {
        token::Client::new(env, &Self::tokens(env).get_unchecked(index))
            .balance(&env.current_contract_address()) as u128
    }
}

#[contractimpl]
impl AquariusMock {
    pub fn __constructor(env: Env, token_a: Address, token_b: Address) {
        env.storage()
            .instance()
            .set(&PoolKey::Tokens, &vec![&env, token_a, token_b]);
    }

    /// The share token is a Stellar asset whose admin is this pool.
    pub fn set_share(env: Env, share: Address) {
        env.storage().instance().set(&PoolKey::Share, &share);
    }

    pub fn get_tokens(env: Env) -> Vec<Address> {
        Self::tokens(&env)
    }

    pub fn pool_type(env: Env) -> Symbol {
        Symbol::new(&env, "constant_product")
    }

    pub fn share_id(env: Env) -> Address {
        env.storage().instance().get(&PoolKey::Share).unwrap()
    }

    pub fn get_reserves(env: Env) -> Vec<u128> {
        vec![&env, Self::reserve(&env, 0), Self::reserve(&env, 1)]
    }

    pub fn get_total_shares(env: Env) -> u128 {
        env.storage().instance().get(&PoolKey::Total).unwrap_or(0)
    }

    pub fn get_user_shares(env: Env, user: Address) -> u128 {
        token::Client::new(&env, &Self::share_id(env.clone())).balance(&user) as u128
    }

    /// Takes exactly the desired amounts with `transfer`; callers keep them proportional.
    pub fn deposit(
        env: Env,
        user: Address,
        desired_amounts: Vec<u128>,
        _min_shares: u128,
    ) -> (Vec<u128>, u128) {
        user.require_auth();
        let total = Self::get_total_shares(env.clone());
        let (a, b) = (
            desired_amounts.get_unchecked(0),
            desired_amounts.get_unchecked(1),
        );
        let minted = if total == 0 {
            a.min(b)
        } else {
            (a * total / Self::reserve(&env, 0)).min(b * total / Self::reserve(&env, 1))
        };
        let me = env.current_contract_address();
        for (token, amount) in Self::tokens(&env).iter().zip(desired_amounts.iter()) {
            token::Client::new(&env, &token).transfer(&user, &me, &(amount as i128));
        }
        token::StellarAssetClient::new(&env, &Self::share_id(env.clone()))
            .mint(&user, &(minted as i128));
        env.storage()
            .instance()
            .set(&PoolKey::Total, &(total + minted));
        (desired_amounts, minted)
    }

    /// Burns the user's shares from the share token, which requires the user's authorization.
    pub fn withdraw(
        env: Env,
        user: Address,
        share_amount: u128,
        _min_amounts: Vec<u128>,
    ) -> Vec<u128> {
        user.require_auth();
        let total = Self::get_total_shares(env.clone());
        let amounts = vec![
            &env,
            Self::reserve(&env, 0) * share_amount / total,
            Self::reserve(&env, 1) * share_amount / total,
        ];
        token::Client::new(&env, &Self::share_id(env.clone())).burn(&user, &(share_amount as i128));
        env.storage()
            .instance()
            .set(&PoolKey::Total, &(total - share_amount));
        let me = env.current_contract_address();
        for (token, amount) in Self::tokens(&env).iter().zip(amounts.iter()) {
            token::Client::new(&env, &token).transfer(&me, &user, &(amount as i128));
        }
        amounts
    }

    /// Fee-less constant-product swap.
    pub fn swap(env: Env, user: Address, in_idx: u32, out_idx: u32, in_amount: u128) -> u128 {
        user.require_auth();
        let (reserve_in, reserve_out) = (Self::reserve(&env, in_idx), Self::reserve(&env, out_idx));
        let out = reserve_out * in_amount / (reserve_in + in_amount);
        let tokens = Self::tokens(&env);
        let me = env.current_contract_address();
        token::Client::new(&env, &tokens.get_unchecked(in_idx)).transfer(
            &user,
            &me,
            &(in_amount as i128),
        );
        token::Client::new(&env, &tokens.get_unchecked(out_idx)).transfer(
            &me,
            &user,
            &(out as i128),
        );
        out
    }
}
