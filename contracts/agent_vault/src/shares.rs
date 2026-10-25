use soroban_sdk::{Address, Env, U256};

use crate::{Error, Key};

pub(crate) const VIRTUAL_SHARES: i128 = 1_000_000_000;
pub(crate) const PRICE_SCALE: i128 = 1_000_000_000_000_000_000;

pub(crate) fn mul_div(
    env: &Env,
    a: i128,
    b: i128,
    divisor: i128,
    ceil: bool,
) -> Result<i128, Error> {
    if a < 0 || b < 0 || divisor <= 0 {
        return Err(Error::ArithmeticOverflow);
    }
    if let Some(product) = a.checked_mul(b) {
        let quotient = product / divisor;
        return quotient
            .checked_add(i128::from(ceil && product % divisor != 0))
            .ok_or(Error::ArithmeticOverflow);
    }
    let product = U256::from_u128(env, a as u128).mul(&U256::from_u128(env, b as u128));
    let divisor = U256::from_u128(env, divisor as u128);
    let mut result = product.div(&divisor);
    if ceil && product.rem_euclid(&divisor) != U256::from_u32(env, 0) {
        result = result.add(&U256::from_u32(env, 1));
    }
    result
        .to_u128()
        .and_then(|value| i128::try_from(value).ok())
        .ok_or(Error::ArithmeticOverflow)
}

pub(crate) fn total(env: &Env) -> i128 {
    env.storage().instance().get(&Key::TotalShares).unwrap()
}

pub(crate) fn effective_supply(env: &Env) -> Result<i128, Error> {
    total(env)
        .checked_add(VIRTUAL_SHARES)
        .ok_or(Error::ArithmeticOverflow)
}

pub(crate) fn effective_assets(nav: i128) -> Result<i128, Error> {
    nav.checked_add(1).ok_or(Error::ArithmeticOverflow)
}

pub(crate) fn price(env: &Env, nav: i128) -> Result<i128, Error> {
    mul_div(
        env,
        effective_assets(nav)?,
        PRICE_SCALE,
        effective_supply(env)?,
        false,
    )
}

pub(crate) fn balance(env: &Env, user: &Address) -> i128 {
    let key = Key::Shares(user.clone());
    let storage = env.storage().persistent();
    if let Some(value) = storage.get(&key) {
        storage.extend_ttl(&key, 17_280, 120_960);
        value
    } else {
        0
    }
}

pub(crate) fn touch(env: &Env, user: &Address) {
    let key = Key::Shares(user.clone());
    let storage = env.storage().persistent();
    let value: i128 = storage.get(&key).unwrap_or(0);
    storage.set(&key, &value);
    storage.extend_ttl(&key, 17_280, 120_960);
}

pub(crate) fn mint(env: &Env, user: &Address, amount: i128) -> Result<(), Error> {
    let balance = balance(env, user)
        .checked_add(amount)
        .ok_or(Error::ArithmeticOverflow)?;
    let total = total(env)
        .checked_add(amount)
        .ok_or(Error::ArithmeticOverflow)?;
    // Reserve room for the virtual shares in every conversion.
    total
        .checked_add(VIRTUAL_SHARES)
        .ok_or(Error::ArithmeticOverflow)?;
    env.storage()
        .persistent()
        .set(&Key::Shares(user.clone()), &balance);
    env.storage()
        .persistent()
        .extend_ttl(&Key::Shares(user.clone()), 17_280, 120_960);
    env.storage().instance().set(&Key::TotalShares, &total);
    Ok(())
}

pub(crate) fn burn(env: &Env, user: &Address, amount: i128) -> Result<(), Error> {
    let balance = balance(env, user);
    if amount > balance {
        return Err(Error::InsufficientShares);
    }
    if amount == balance {
        env.storage()
            .persistent()
            .remove(&Key::Shares(user.clone()));
    } else {
        env.storage()
            .persistent()
            .set(&Key::Shares(user.clone()), &(balance - amount));
    }
    env.storage()
        .instance()
        .set(&Key::TotalShares, &(total(env) - amount));
    Ok(())
}
