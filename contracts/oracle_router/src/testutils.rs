//! Reflector and Chainlink doubles with the same call signatures as the testnet contracts.

use soroban_sdk::{contract, contracterror, contractimpl, BytesN, Env, Vec, I256};

use crate::{PriceData, ReflectorAsset, Round};

/// Reflector (SEP-40) double: prices are pushed newest first, 14 decimals.
#[contract]
pub struct MockReflector;

#[contractimpl]
impl MockReflector {
    pub fn push(env: Env, asset: ReflectorAsset, price: i128, timestamp: u64) {
        let mut history: Vec<PriceData> = env
            .storage()
            .instance()
            .get(&asset)
            .unwrap_or(Vec::new(&env));
        history.push_front(PriceData { price, timestamp });
        env.storage().instance().set(&asset, &history);
    }

    pub fn decimals(_env: Env) -> u32 {
        14
    }

    pub fn lastprice(env: Env, asset: ReflectorAsset) -> Option<PriceData> {
        env.storage()
            .instance()
            .get::<_, Vec<PriceData>>(&asset)
            .and_then(|history| history.first())
    }

    pub fn prices(env: Env, asset: ReflectorAsset, records: u32) -> Option<Vec<PriceData>> {
        let history: Vec<PriceData> = env.storage().instance().get(&asset)?;
        Some(history.slice(0..records.min(history.len())))
    }
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProxyReadError {
    NoDataPresent = 50,
}

/// Chainlink Data Feeds proxy double; answers are stored with 18 decimals.
#[contract]
pub struct MockChainlink;

#[contractimpl]
impl MockChainlink {
    pub fn set_round(env: Env, data_id: BytesN<32>, answer: i128, timestamp: u64) {
        let round_id = env
            .storage()
            .instance()
            .get::<_, Round>(&data_id)
            .map_or(1, |round| round.round_id + 1);
        env.storage().instance().set(
            &data_id,
            &Round {
                answer: I256::from_i128(&env, answer),
                round_id,
                timestamp,
            },
        );
    }

    pub fn latest_round(
        env: Env,
        data_id: BytesN<32>,
        decimals: u32,
    ) -> Result<Round, ProxyReadError> {
        assert_eq!(decimals, 18);
        env.storage()
            .instance()
            .get(&data_id)
            .ok_or(ProxyReadError::NoDataPresent)
    }
}
