use soroban_sdk::{contractclient, contracttype, BytesN, Env, Vec, I256};

use crate::{Config, Error, ReflectorAsset, BPS};

/// Every source is normalized to USD with this many decimals before combining.
pub(crate) const USD_DECIMALS: u32 = 18;
/// Chainlink proxies scale answers to the requested precision.
const CHAINLINK_DECIMALS: u32 = USD_DECIMALS;

/// SEP-40 record, as returned by Reflector.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Chainlink Data Feeds proxy round.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Round {
    pub answer: I256,
    pub round_id: u64,
    pub timestamp: u64,
}

#[allow(dead_code)]
#[contractclient(name = "ReflectorClient")]
pub trait Reflector {
    fn lastprice(env: Env, asset: ReflectorAsset) -> Option<PriceData>;
    fn prices(env: Env, asset: ReflectorAsset, records: u32) -> Option<Vec<PriceData>>;
}

#[allow(dead_code)]
#[contractclient(name = "ChainlinkClient")]
pub trait Chainlink {
    fn latest_round(env: Env, data_id: BytesN<32>, decimals: u32) -> Round;
}

pub(crate) fn pow10(exp: u32) -> Result<i128, Error> {
    10_i128.checked_pow(exp).ok_or(Error::InvalidConfig)
}

fn rescale(value: i128, from: u32, to: u32) -> Result<i128, Error> {
    if from <= to {
        value
            .checked_mul(pow10(to - from)?)
            .ok_or(Error::BadSourceData)
    } else {
        Ok(value / pow10(from - to)?)
    }
}

fn fresh(env: &Env, timestamp: u64, max_age: u64) -> Result<(), Error> {
    if env.ledger().timestamp().saturating_sub(timestamp) > max_age {
        return Err(Error::StalePrice);
    }
    Ok(())
}

/// Latest Reflector price in 18-decimal USD. A missing record, a failing call
/// or an old record are all "no fresh price": the strict regime fails closed.
pub(crate) fn reflector(env: &Env, config: &Config, asset: &ReflectorAsset) -> Result<i128, Error> {
    let record = match ReflectorClient::new(env, &config.reflector).try_lastprice(asset) {
        Ok(Ok(Some(record))) => record,
        _ => return Err(Error::StalePrice),
    };
    fresh(env, record.timestamp, config.reflector_max_age)?;
    if record.price <= 0 {
        return Err(Error::BadSourceData);
    }
    rescale(record.price, config.reflector_decimals, USD_DECIMALS)
}

/// The two latest Reflector updates agree within `tolerance_bps`: a move seen
/// on consecutive updates is a new level, not a one-off print.
pub(crate) fn reflector_stable(
    env: &Env,
    config: &Config,
    asset: &ReflectorAsset,
    tolerance_bps: u32,
) -> bool {
    let records = match ReflectorClient::new(env, &config.reflector).try_prices(asset, &2) {
        Ok(Ok(Some(records))) if records.len() >= 2 => records,
        _ => return false,
    };
    let (latest, previous) = (records.get_unchecked(0), records.get_unchecked(1));
    latest.price > 0
        && previous.price > 0
        && latest.timestamp != previous.timestamp
        && fresh(
            env,
            latest.timestamp.min(previous.timestamp),
            config.reflector_max_age,
        )
        .is_ok()
        && !moved(latest.price, previous.price, tolerance_bps)
}

/// Latest Chainlink answer in 18-decimal USD.
pub(crate) fn chainlink(env: &Env, config: &Config, data_id: &BytesN<32>) -> Result<i128, Error> {
    let round = match ChainlinkClient::new(env, &config.chainlink)
        .try_latest_round(data_id, &CHAINLINK_DECIMALS)
    {
        Ok(Ok(round)) => round,
        _ => return Err(Error::StalePrice),
    };
    fresh(env, round.timestamp, config.chainlink_max_age)?;
    match round.answer.to_i128() {
        Some(answer) if answer > 0 => Ok(answer),
        _ => Err(Error::BadSourceData),
    }
}

/// `true` when `a` differs from the reference `b` by more than `bps` of `b`.
pub(crate) fn moved(a: i128, b: i128, bps: u32) -> bool {
    let diff = a.abs_diff(b);
    let limit = (b.unsigned_abs()).saturating_mul(bps as u128) / BPS as u128;
    diff > limit
}
