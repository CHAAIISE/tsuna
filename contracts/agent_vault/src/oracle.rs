//! Valuation of non-base assets held idle, through the oracle router.
//!
//! Agent paths use the strict regime and fail closed. Withdrawals use the exit regime and
//! never fail because of the oracle: without a usable price the holder is paid in kind.

use soroban_sdk::{token, vec, Address, Env, IntoVal, InvokeError, Symbol, Vec};

use crate::{shares::mul_div, Error, Key};

// Router error codes.
const NO_PRICE_FEED: u32 = 1;
const STALE_PRICE: u32 = 2;
const SOURCES_DISAGREE: u32 = 3;
const PRICE_JUMP: u32 = 4;

fn router(env: &Env) -> Address {
    env.storage().instance().get(&Key::Oracle).unwrap()
}

/// Non-base `assets` with a positive idle balance; the base asset comes first and is skipped.
pub(crate) fn held(env: &Env, assets: &Vec<Address>) -> Vec<(Address, i128)> {
    let me = env.current_contract_address();
    let mut out = Vec::new(env);
    for asset in assets.iter().skip(1) {
        let balance = token::Client::new(env, &asset).balance(&me);
        if balance > 0 {
            out.push_back((asset, balance));
        }
    }
    out
}

/// Strict price in quote units (7 decimals); `None` when the asset has no configured feed.
fn strict(env: &Env, asset: &Address) -> Result<Option<i128>, Error> {
    match env.try_invoke_contract::<i128, InvokeError>(
        &router(env),
        &Symbol::new(env, "price_strict"),
        vec![env, asset.into_val(env)],
    ) {
        Ok(Ok(price)) if price > 0 => Ok(Some(price)),
        Err(Ok(InvokeError::Contract(NO_PRICE_FEED))) => Ok(None),
        Err(Ok(InvokeError::Contract(STALE_PRICE))) => Err(Error::StalePrice),
        Err(Ok(InvokeError::Contract(SOURCES_DISAGREE))) => Err(Error::SourcesDisagree),
        Err(Ok(InvokeError::Contract(PRICE_JUMP))) => Err(Error::PriceJump),
        _ => Err(Error::OracleUnavailable),
    }
}

fn exit(env: &Env, asset: &Address) -> Option<i128> {
    match env.try_invoke_contract::<Option<i128>, InvokeError>(
        &router(env),
        &Symbol::new(env, "price_for_exit"),
        vec![env, asset.into_val(env)],
    ) {
        Ok(Ok(Some(price))) if price > 0 => Some(price),
        _ => None,
    }
}

fn unit(env: &Env, asset: &Address) -> Option<i128> {
    match token::Client::new(env, asset).try_decimals() {
        Ok(Ok(decimals)) => 10_i128.checked_pow(decimals),
        _ => None,
    }
}

/// Converts `amount` of `asset` into base-asset units, both prices being in quote units.
fn value(
    env: &Env,
    asset: &Address,
    amount: i128,
    price: i128,
    base: &Address,
    base_price: i128,
) -> Result<i128, Error> {
    let (asset_unit, base_unit) = unit(env, asset)
        .zip(unit(env, base))
        .ok_or(Error::BadAdapterData)?;
    let numerator = price
        .checked_mul(base_unit)
        .ok_or(Error::ArithmeticOverflow)?;
    let denominator = base_price
        .checked_mul(asset_unit)
        .ok_or(Error::ArithmeticOverflow)?;
    mul_div(env, amount, numerator, denominator, false)
}

/// Value of idle non-base assets at strict prices. Assets without a feed count as 0,
/// so converting into an unpriced asset reads as a loss; any other oracle failure blocks.
pub(crate) fn strict_value(
    env: &Env,
    base: &Address,
    assets: &Vec<Address>,
) -> Result<i128, Error> {
    let held = held(env, assets);
    if held.is_empty() {
        return Ok(0);
    }
    let Some(base_price) = strict(env, base)? else {
        return Ok(0);
    };
    let mut total: i128 = 0;
    for (asset, balance) in held {
        if let Some(price) = strict(env, &asset)? {
            total = total
                .checked_add(value(env, &asset, balance, price, base, base_price)?)
                .ok_or(Error::ArithmeticOverflow)?;
        }
    }
    Ok(total)
}

/// Exit values of `held`, in base units and in the same order, or `None` when any of them
/// has no usable price. The base price must be strict: a stale base price cut by the haircut
/// would inflate the other assets in favour of the leaver.
pub(crate) fn exit_values(
    env: &Env,
    base: &Address,
    held: &Vec<(Address, i128)>,
) -> Option<Vec<i128>> {
    let mut out = Vec::new(env);
    if held.is_empty() {
        return Some(out);
    }
    let base_price = strict(env, base).ok().flatten()?;
    for (asset, balance) in held.iter() {
        let price = exit(env, &asset)?;
        out.push_back(value(env, &asset, balance, price, base, base_price).ok()?);
    }
    Some(out)
}
