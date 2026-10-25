//! Blend pool double: reserves with their own b-rate and factors, positions per user.

use soroban_sdk::{
    contract, contractimpl, contracttype, map, symbol_short, token, Address, Env, IntoVal, Map,
    Symbol, Val, Vec,
};

use crate::adapters::blend::Request;

pub(crate) const RATE: i128 = 1_000_000_000_000;
/// The base asset sits at index 3, as USDC does in the testnet pool.
pub(crate) const BASE_INDEX: u32 = 3;

#[contracttype]
#[derive(Clone)]
enum BlendKey {
    Reserves,
    Index(Address),
    Rate(u32),
    Factors(u32),
    Supply(Address, u32),
    Collateral(Address, u32),
    Debt(Address, u32),
    Sink,
}

#[contract]
pub struct BlendMock;

#[contractimpl]
impl BlendMock {
    pub fn __constructor(env: Env, asset: Address) {
        let s = env.storage().instance();
        let mut reserves = Vec::new(&env);
        for _ in 0..=BASE_INDEX {
            reserves.push_back(asset.clone());
        }
        s.set(&BlendKey::Reserves, &reserves);
        s.set(&BlendKey::Index(asset), &BASE_INDEX);
        s.set(&BlendKey::Rate(BASE_INDEX), &RATE);
        s.set(
            &BlendKey::Factors(BASE_INDEX),
            &(9_000_000_u32, 9_000_000_u32),
        );
    }

    pub fn add_reserve(env: Env, asset: Address, c_factor: u32, l_factor: u32) -> u32 {
        let s = env.storage().instance();
        let mut reserves: Vec<Address> = s.get(&BlendKey::Reserves).unwrap();
        let index = reserves.len();
        reserves.push_back(asset.clone());
        s.set(&BlendKey::Reserves, &reserves);
        s.set(&BlendKey::Index(asset), &index);
        s.set(&BlendKey::Rate(index), &RATE);
        s.set(&BlendKey::Factors(index), &(c_factor, l_factor));
        index
    }

    /// b-rate of the base reserve.
    pub fn set_rate(env: Env, rate: i128) {
        env.storage()
            .instance()
            .set(&BlendKey::Rate(BASE_INDEX), &rate);
    }

    /// Simulates a compromised pool: inflows go to `sink` while positions are still credited.
    pub fn set_sink(env: Env, sink: Address) {
        env.storage().instance().set(&BlendKey::Sink, &sink);
    }

    pub fn get_reserve_list(env: Env) -> Vec<Address> {
        env.storage().instance().get(&BlendKey::Reserves).unwrap()
    }

    pub fn get_positions(env: Env, address: Address) -> Map<Symbol, Val> {
        let s = env.storage().instance();
        let count = Self::get_reserve_list(env.clone()).len();
        let (mut supply, mut collateral, mut debt) =
            (Map::new(&env), Map::new(&env), Map::new(&env));
        for index in 0..count {
            for (map, key) in [
                (&mut supply, BlendKey::Supply(address.clone(), index)),
                (
                    &mut collateral,
                    BlendKey::Collateral(address.clone(), index),
                ),
                (&mut debt, BlendKey::Debt(address.clone(), index)),
            ] {
                let value: i128 = s.get(&key).unwrap_or(0);
                if value != 0 || index == BASE_INDEX {
                    map.set(index, value);
                }
            }
        }
        map![
            &env,
            (symbol_short!("supply"), supply.into_val(&env)),
            (Symbol::new(&env, "collateral"), collateral.into_val(&env)),
            (Symbol::new(&env, "liabilities"), debt.into_val(&env)),
        ]
    }

    pub fn get_reserve(env: Env, asset: Address) -> Map<Symbol, Val> {
        let s = env.storage().instance();
        let index: u32 = s.get(&BlendKey::Index(asset)).unwrap();
        let rate: i128 = s.get(&BlendKey::Rate(index)).unwrap();
        let (c_factor, l_factor): (u32, u32) = s.get(&BlendKey::Factors(index)).unwrap();
        let data: Map<Symbol, i128> = map![
            &env,
            (symbol_short!("b_rate"), rate),
            (symbol_short!("d_rate"), RATE),
        ];
        let config = map![
            &env,
            (symbol_short!("c_factor"), c_factor),
            (symbol_short!("l_factor"), l_factor),
        ];
        map![
            &env,
            (symbol_short!("data"), data.into_val(&env)),
            (symbol_short!("config"), config.into_val(&env)),
        ]
    }

    /// Nets transfers per token like Blend: pulls each token's excess inflow from `spender`.
    pub fn submit_with_allowance(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) {
        spender.require_auth();
        if from != spender {
            from.require_auth();
        }
        let s = env.storage().instance();
        let me = env.current_contract_address();
        let mut nets: Map<Address, i128> = Map::new(&env);
        for request in requests {
            let index: u32 = s.get(&BlendKey::Index(request.address.clone())).unwrap();
            let rate: i128 = s.get(&BlendKey::Rate(index)).unwrap();
            let key = match request.request_type {
                0 | 1 => BlendKey::Supply(from.clone(), index),
                2 | 3 => BlendKey::Collateral(from.clone(), index),
                4 | 5 => BlendKey::Debt(from.clone(), index),
                _ => panic!("unsupported request"),
            };
            let previous: i128 = s.get(&key).unwrap_or(0);
            let (new, delta) = match request.request_type {
                0 | 2 => (previous + request.amount * RATE / rate, -request.amount),
                1 | 3 => {
                    let burnt = (request.amount * RATE + rate - 1) / rate;
                    assert!(burnt <= previous);
                    (previous - burnt, request.amount)
                }
                4 => (previous + request.amount, request.amount),
                5 => {
                    let repaid = request.amount.min(previous);
                    (previous - repaid, -repaid)
                }
                _ => unreachable!(),
            };
            s.set(&key, &new);
            let net = nets.get(request.address.clone()).unwrap_or(0);
            nets.set(request.address, net + delta);
        }
        for (asset, net) in nets.iter() {
            let token = token::Client::new(&env, &asset);
            if net < 0 {
                let dest: Address = s.get(&BlendKey::Sink).unwrap_or(me.clone());
                token.transfer_from(&me, &spender, &dest, &-net);
            } else if net > 0 {
                token.transfer(&me, &to, &net);
            }
        }
    }
}
