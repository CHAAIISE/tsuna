use soroban_sdk::{
    contracttype, symbol_short, token, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

use crate::{shares::mul_div, BlendPosition, Error};

const SCALAR: i128 = 1_000_000_000_000;

#[contracttype]
#[derive(Clone)]
pub(crate) struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}

struct Position {
    supply: i128,
    collateral: i128,
    debt: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: u32,
    l_factor: u32,
}

fn load(env: &Env, asset: &Address, position: &BlendPosition) -> Result<Position, Error> {
    let positions: Map<Symbol, Val> = env.invoke_contract(
        &position.pool,
        &Symbol::new(env, "get_positions"),
        (env.current_contract_address(),).into_val(env),
    );
    let reserve: Map<Symbol, Val> = env.invoke_contract(
        &position.pool,
        &Symbol::new(env, "get_reserve"),
        (asset,).into_val(env),
    );
    let data: Map<Symbol, Val> = field(env, &reserve, symbol_short!("data"))?;
    let config: Map<Symbol, Val> = field(env, &reserve, symbol_short!("config"))?;
    let b_rate = field(env, &data, symbol_short!("b_rate"))?;
    let d_rate = field(env, &data, symbol_short!("d_rate"))?;
    if b_rate <= 0 || d_rate <= 0 {
        return Err(Error::BadAdapterData);
    }
    Ok(Position {
        supply: entry(
            env,
            &positions,
            symbol_short!("supply"),
            position.reserve_index,
        )?,
        collateral: entry(
            env,
            &positions,
            Symbol::new(env, "collateral"),
            position.reserve_index,
        )?,
        debt: entry(
            env,
            &positions,
            Symbol::new(env, "liabilities"),
            position.reserve_index,
        )?,
        b_rate,
        d_rate,
        c_factor: field(env, &config, symbol_short!("c_factor"))?,
        l_factor: field(env, &config, symbol_short!("l_factor"))?,
    })
}

pub(crate) fn nav(env: &Env, asset: &Address, position: &BlendPosition) -> Result<i128, Error> {
    let p = load(env, asset, position)?;
    // Blend values each position separately: both supply and collateral round down.
    let supply = mul_div(env, p.supply, p.b_rate, SCALAR, false)?;
    let collateral = mul_div(env, p.collateral, p.b_rate, SCALAR, false)?;
    let debt = mul_div(env, p.debt, p.d_rate, SCALAR, true)?;
    supply
        .checked_add(collateral)
        .and_then(|assets| assets.checked_sub(debt))
        .ok_or(Error::ArithmeticOverflow)
}

pub(crate) fn gross(env: &Env, asset: &Address, position: &BlendPosition) -> Result<i128, Error> {
    let p = load(env, asset, position)?;
    mul_div(env, p.supply, p.b_rate, SCALAR, false)?
        .checked_add(mul_div(env, p.collateral, p.b_rate, SCALAR, false)?)
        .ok_or(Error::ArithmeticOverflow)
}

pub(crate) fn health_factor(
    env: &Env,
    asset: &Address,
    position: &BlendPosition,
) -> Result<i128, Error> {
    let p = load(env, asset, position)?;
    if p.debt == 0 {
        return Ok(i128::MAX);
    }
    if p.c_factor > 10_000_000 || p.l_factor == 0 || p.l_factor > 10_000_000 {
        return Err(Error::BadAdapterData);
    }
    // The base asset is both collateral and liability, so its oracle price cancels.
    let collateral = mul_div(env, p.collateral, p.b_rate, SCALAR, false)?;
    let debt = mul_div(env, p.debt, p.d_rate, SCALAR, true)?;
    let collateral = mul_div(env, collateral, p.c_factor.into(), 10_000_000, false)?;
    let debt = mul_div(env, debt, 10_000_000, p.l_factor.into(), true)?;
    mul_div(env, collateral, 10_000, debt, false)
}

pub(crate) fn unwind(
    env: &Env,
    asset: &Address,
    position: &BlendPosition,
    shares: i128,
    supply: i128,
) -> Result<(), Error> {
    let p = load(env, asset, position)?;
    let mut requests = Vec::new(env);
    for (tokens, rate, request_type, ceil) in [
        (p.supply, p.b_rate, 1, false),
        (p.collateral, p.b_rate, 3, false),
        (p.debt, p.d_rate, 5, true),
    ] {
        let portion = mul_div(env, tokens, shares, supply, ceil)?;
        let amount = mul_div(env, portion, rate, SCALAR, ceil)?;
        if amount > 0 {
            requests.push_back(Request {
                address: asset.clone(),
                amount,
                request_type,
            });
        }
    }
    if requests.is_empty() {
        return Ok(());
    }
    let me = env.current_contract_address();
    let token = token::Client::new(env, asset);
    // Repay and withdrawals are netted by Blend in one invocation. Only the
    // vault constructs this approval; the session key cannot choose a payee.
    let repay = requests
        .iter()
        .find(|r| r.request_type == 5)
        .map(|r| r.amount)
        .unwrap_or(0);
    if repay > 0 {
        token.approve(&me, &position.pool, &repay, &env.ledger().sequence());
    }
    let _: Val = env.invoke_contract(
        &position.pool,
        &Symbol::new(env, "submit_with_allowance"),
        (me.clone(), me.clone(), me.clone(), requests).into_val(env),
    );
    if repay > 0 {
        token.approve(&me, &position.pool, &0, &env.ledger().sequence());
    }
    Ok(())
}

fn field<T: TryFromVal<Env, Val>>(
    env: &Env,
    map: &Map<Symbol, Val>,
    key: Symbol,
) -> Result<T, Error> {
    T::try_from_val(env, &map.get(key).ok_or(Error::BadAdapterData)?)
        .map_err(|_| Error::BadAdapterData)
}

fn entry(env: &Env, positions: &Map<Symbol, Val>, key: Symbol, index: u32) -> Result<i128, Error> {
    let map: Map<u32, i128> = field(env, positions, key)?;
    let value = map.get(index).unwrap_or(0);
    if value < 0 {
        return Err(Error::BadAdapterData);
    }
    Ok(value)
}
