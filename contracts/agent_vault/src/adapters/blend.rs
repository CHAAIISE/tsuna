use soroban_sdk::{
    contracttype, symbol_short, token, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

use super::{add, need, Holding, Needs};
use crate::{oracle::Prices, shares::mul_div, Error};

/// Blend's fixed-point scale for b/d rates.
const SCALAR: i128 = 1_000_000_000_000;
/// Blend's scale for collateral and liability factors.
const FACTOR: i128 = 10_000_000;
/// Rounding of one pro-rata repayment (shares then rate, both up) and of the same-asset
/// releases netted against it (supply and collateral, both down).
const MARGIN: i128 = 6;

#[contracttype]
#[derive(Clone)]
pub(crate) struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}

/// The vault's position in one reserve, in b/d tokens, with the reserve's rates and factors.
#[contracttype]
#[derive(Clone)]
struct Line {
    asset: Address,
    supply: i128,
    collateral: i128,
    debt: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
    l_factor: i128,
}

impl Line {
    fn released(&self, env: &Env) -> Result<i128, Error> {
        // Blend values each position separately: both supply and collateral round down.
        add(
            mul_div(env, self.supply, self.b_rate, SCALAR, false)?,
            mul_div(env, self.collateral, self.b_rate, SCALAR, false)?,
        )
    }

    fn owed(&self, env: &Env) -> Result<i128, Error> {
        mul_div(env, self.debt, self.d_rate, SCALAR, true)
    }
}

/// Every reserve where the vault has supply, collateral or debt.
fn lines(env: &Env, pool: &Address) -> Result<Vec<Line>, Error> {
    let positions: Map<Symbol, Val> = env.invoke_contract(
        pool,
        &Symbol::new(env, "get_positions"),
        (env.current_contract_address(),).into_val(env),
    );
    let mut balances: Vec<(u32, i128, i128, i128)> = Vec::new(env);
    for (slot, key) in [
        (0, symbol_short!("supply")),
        (1, Symbol::new(env, "collateral")),
        (2, Symbol::new(env, "liabilities")),
    ] {
        let map: Map<u32, i128> = field(env, &positions, key)?;
        for (index, value) in map.iter() {
            if value < 0 {
                return Err(Error::BadAdapterData);
            }
            if value == 0 {
                continue;
            }
            let at = balances.iter().position(|(i, ..)| i == index);
            let mut row = match at {
                Some(at) => balances.get_unchecked(at as u32),
                None => (index, 0, 0, 0),
            };
            match slot {
                0 => row.1 = value,
                1 => row.2 = value,
                _ => row.3 = value,
            }
            match at {
                Some(at) => balances.set(at as u32, row),
                None => balances.push_back(row),
            }
        }
    }
    let mut out = Vec::new(env);
    if balances.is_empty() {
        return Ok(out);
    }
    let reserves: Vec<Address> =
        env.invoke_contract(pool, &Symbol::new(env, "get_reserve_list"), Vec::new(env));
    for (index, supply, collateral, debt) in balances {
        let asset = reserves.get(index).ok_or(Error::BadAdapterData)?;
        let reserve: Map<Symbol, Val> = env.invoke_contract(
            pool,
            &Symbol::new(env, "get_reserve"),
            (asset.clone(),).into_val(env),
        );
        let data: Map<Symbol, Val> = field(env, &reserve, symbol_short!("data"))?;
        let config: Map<Symbol, Val> = field(env, &reserve, symbol_short!("config"))?;
        let b_rate: i128 = field(env, &data, symbol_short!("b_rate"))?;
        let d_rate: i128 = field(env, &data, symbol_short!("d_rate"))?;
        let c_factor: u32 = field(env, &config, symbol_short!("c_factor"))?;
        let l_factor: u32 = field(env, &config, symbol_short!("l_factor"))?;
        if b_rate <= 0
            || d_rate <= 0
            || i128::from(c_factor) > FACTOR
            || l_factor == 0
            || i128::from(l_factor) > FACTOR
        {
            return Err(Error::BadAdapterData);
        }
        out.push_back(Line {
            asset,
            supply,
            collateral,
            debt,
            b_rate,
            d_rate,
            c_factor: c_factor.into(),
            l_factor: l_factor.into(),
        });
    }
    Ok(out)
}

/// Supply and collateral less debt, each reserve converted at oracle prices; the health factor
/// weights follow Blend: collateral × c_factor against debt ÷ l_factor.
pub(crate) fn value(
    env: &Env,
    pool: &Address,
    prices: &mut Prices,
) -> Result<Option<Holding>, Error> {
    let mut total = Holding::default();
    for line in lines(env, pool)? {
        let owed = line.owed(env)?;
        let collateral = mul_div(env, line.collateral, line.b_rate, SCALAR, false)?;
        let weighted = mul_div(env, collateral, line.c_factor, FACTOR, false)?;
        let weighted_owed = mul_div(env, owed, FACTOR, line.l_factor, true)?;
        let (Some(gross), Some(debt), Some(weighted_collateral), Some(weighted_debt)) = (
            prices.value(env, &line.asset, line.released(env)?)?,
            prices.debt(env, &line.asset, owed)?,
            prices.value(env, &line.asset, weighted)?,
            prices.debt(env, &line.asset, weighted_owed)?,
        ) else {
            return Ok(None);
        };
        total.add(&Holding {
            gross,
            debt,
            weighted_collateral,
            weighted_debt,
        })?;
    }
    Ok(Some(total))
}

/// Debt the vault must fund from idle balances: Blend nets a repayment against releases of the
/// same asset within one submission.
pub(crate) fn needs(env: &Env, pool: &Address, needs: &mut Needs) -> Result<(), Error> {
    for line in lines(env, pool)? {
        let owed = line.owed(env)?;
        let released = line.released(env)?;
        if line.debt > 0 && owed > released {
            need(needs, &line.asset, owed - released, MARGIN)?;
        }
    }
    Ok(())
}

pub(crate) fn unwind(env: &Env, pool: &Address, shares: i128, supply: i128) -> Result<(), Error> {
    let mut requests = Vec::new(env);
    let mut repays: Vec<(Address, i128)> = Vec::new(env);
    for line in lines(env, pool)? {
        for (tokens, rate, request_type, ceil) in [
            (line.supply, line.b_rate, 1, false),
            (line.collateral, line.b_rate, 3, false),
            (line.debt, line.d_rate, 5, true),
        ] {
            let part = mul_div(env, tokens, shares, supply, ceil)?;
            let amount = mul_div(env, part, rate, SCALAR, ceil)?;
            if amount > 0 {
                requests.push_back(Request {
                    address: line.asset.clone(),
                    amount,
                    request_type,
                });
                if request_type == 5 {
                    repays.push_back((line.asset.clone(), amount));
                }
            }
        }
    }
    if requests.is_empty() {
        return Ok(());
    }
    let me = env.current_contract_address();
    let expiration = env.ledger().sequence();
    // Repayments and releases are netted by Blend in one invocation. Only the vault
    // constructs these approvals; the session key cannot choose a payee.
    for (asset, amount) in repays.iter() {
        token::Client::new(env, &asset).approve(&me, pool, &amount, &expiration);
    }
    let _: Val = env.invoke_contract(
        pool,
        &Symbol::new(env, "submit_with_allowance"),
        (me.clone(), me.clone(), me.clone(), requests).into_val(env),
    );
    for (asset, _) in repays.iter() {
        token::Client::new(env, &asset).approve(&me, pool, &0, &expiration);
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
