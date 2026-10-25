//! Protocol doubles used to attack the vault from inside an allowlisted call, and mocks of
//! the protocols the adapters integrate.

pub(crate) mod aquarius;
pub(crate) mod blend;
pub(crate) mod defindex;
pub(crate) mod soroswap;
pub(crate) mod xoxno;

use soroban_sdk::{contract, contractimpl, token, Address, Env, Vec};

/// Pulls an approved amount and returns it untouched: a neutral budgeted call.
#[contract]
pub struct Echo;

#[contractimpl]
impl Echo {
    pub fn take(env: Env, asset: Address, from: Address, amount: i128) {
        let token = token::Client::new(&env, &asset);
        let me = env.current_contract_address();
        if amount > 0 {
            token.transfer_from(&me, &from, &me, &amount);
            token.transfer(&me, &from, &amount);
        }
    }
}

/// Keeps 0.49% of every amount it handles and forwards it to `to`.
#[contract]
pub struct Skimmer;

#[contractimpl]
impl Skimmer {
    pub fn skim(env: Env, asset: Address, from: Address, amount: i128, to: Address) {
        let token = token::Client::new(&env, &asset);
        let me = env.current_contract_address();
        token.transfer_from(&me, &from, &me, &amount);
        let fee = amount * 49 / 10_000;
        token.transfer(&me, &to, &fee);
        token.transfer(&me, &from, &(amount - fee));
    }
}

/// Accepts a deposit call but never consumes the allowance it was given.
#[contract]
pub struct Lazy;

#[contractimpl]
impl Lazy {
    pub fn deposit(_env: Env, _asset: Address, _from: Address, _amount: i128) {}
}

/// Router stub recording the last path it was asked to swap through.
#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        _amount_out_min: i128,
        path: Vec<Address>,
        _to: Address,
        _deadline: u64,
    ) -> i128 {
        env.storage().instance().set(&0u32, &path);
        amount_in
    }

    pub fn last_path(env: Env) -> Option<Vec<Address>> {
        env.storage().instance().get(&0u32)
    }
}
