//! Soroswap router and pair doubles: the router moves the input into the pair with `transfer`
//! from `to`, then the pair pays out at a fixed rate.

use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
enum SwapKey {
    Pair,
    Rate,
}

#[contract]
pub struct SoroswapRouterMock;

#[contractimpl]
impl SoroswapRouterMock {
    pub fn __constructor(env: Env, pair: Address) {
        env.storage().instance().set(&SwapKey::Pair, &pair);
    }

    pub fn router_pair_for(env: Env, _token_a: Address, _token_b: Address) -> Address {
        env.storage().instance().get(&SwapKey::Pair).unwrap()
    }

    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        to.require_auth();
        let pair: Address = env.storage().instance().get(&SwapKey::Pair).unwrap();
        let (from, out_asset) = (path.get_unchecked(0), path.get_unchecked(path.len() - 1));
        token::Client::new(&env, &from).transfer(&to, &pair, &amount_in);
        let out = PairMockClient::new(&env, &pair).pay(&out_asset, &amount_in, &to);
        assert!(out >= amount_out_min, "insufficient output");
        vec![&env, amount_in, out]
    }
}

#[contract]
pub struct PairMock;

#[contractimpl]
impl PairMock {
    /// Output units per input unit, scaled by 10^7.
    pub fn __constructor(env: Env, rate: i128) {
        env.storage().instance().set(&SwapKey::Rate, &rate);
    }

    pub fn pay(env: Env, out_asset: Address, amount_in: i128, to: Address) -> i128 {
        let rate: i128 = env.storage().instance().get(&SwapKey::Rate).unwrap();
        let out = amount_in * rate / 10_000_000;
        token::Client::new(&env, &out_asset).transfer(&env.current_contract_address(), &to, &out);
        out
    }
}
