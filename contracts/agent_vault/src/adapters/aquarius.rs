use policy_registry::PolicyV2;
use soroban_sdk::{
    auth::InvokerContractAuthEntry, symbol_short, vec, Address, Env, IntoVal, Symbol, Val, Vec,
};

use super::{add, arg, entry, require_allowed, transfer, vault_arg, Holding};
use crate::{oracle::Prices, shares::mul_div, Error};

fn tokens(env: &Env, pool: &Address) -> Result<Vec<Address>, Error> {
    let tokens: Vec<Address> =
        env.invoke_contract(pool, &Symbol::new(env, "get_tokens"), Vec::new(env));
    if tokens.len() != 2 {
        return Err(Error::BadAdapterData);
    }
    Ok(tokens)
}

fn share_token(env: &Env, pool: &Address) -> Address {
    env.invoke_contract(pool, &Symbol::new(env, "share_id"), Vec::new(env))
}

fn signed(value: u128) -> Result<i128, Error> {
    i128::try_from(value).map_err(|_| Error::ArithmeticOverflow)
}

fn lp_balance(env: &Env, pool: &Address) -> Result<i128, Error> {
    signed(env.invoke_contract(
        pool,
        &Symbol::new(env, "get_user_shares"),
        vec![env, env.current_contract_address().into_val(env)],
    ))
}

/// The valuation below holds for two-token constant-product pools only.
pub(crate) fn validate(env: &Env, pool: &Address) -> Result<(), Error> {
    tokens(env, pool)?;
    let kind: Symbol = env.invoke_contract(pool, &Symbol::new(env, "pool_type"), Vec::new(env));
    if kind != Symbol::new(env, "constant_product") {
        return Err(Error::BadAdapterData);
    }
    Ok(())
}

fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Start above the root; Newton's iteration then decreases monotonically to the floor.
    let mut x = 1_u128 << (128 - n.leading_zeros()).div_ceil(2);
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// LP shares × the pool's reserves at oracle prices, taken at the pool's invariant:
/// 2·√(v₀·v₁) equals v₀ + v₁ when the pool trades at the oracle price and is lower otherwise,
/// so skewing the pool's reserves can only lower the vault's NAV, never inflate it.
pub(crate) fn value(
    env: &Env,
    pool: &Address,
    prices: &mut Prices,
) -> Result<Option<Holding>, Error> {
    let lp = lp_balance(env, pool)?;
    if lp == 0 {
        return Ok(Some(Holding::default()));
    }
    let total =
        signed(env.invoke_contract(pool, &Symbol::new(env, "get_total_shares"), Vec::new(env)))?;
    let reserves: Vec<u128> =
        env.invoke_contract(pool, &Symbol::new(env, "get_reserves"), Vec::new(env));
    let tokens = tokens(env, pool)?;
    if reserves.len() != 2 || total < lp {
        return Err(Error::BadAdapterData);
    }
    let mut values: [u128; 2] = [0; 2];
    for (index, slot) in values.iter_mut().enumerate() {
        let index = index as u32;
        let reserve = signed(reserves.get_unchecked(index))?;
        let Some(value) = prices.value(env, &tokens.get_unchecked(index), reserve)? else {
            return Ok(None);
        };
        *slot = value as u128;
    }
    let product = values[0]
        .checked_mul(values[1])
        .ok_or(Error::ArithmeticOverflow)?;
    let pool_value = signed(isqrt(product))?
        .checked_mul(2)
        .ok_or(Error::ArithmeticOverflow)?;
    Ok(Some(Holding {
        gross: mul_div(env, pool_value, lp, total, false)?,
        ..Holding::default()
    }))
}

/// `deposit(user, desired_amounts, min_shares)` pulls each token from `user` with `transfer`;
/// `withdraw(user, share_amount, min_amounts)` burns the user's LP shares. The vault authorizes
/// exactly those amounts, so a deposit must be proportional to the reserves to go through.
pub(crate) fn prepare(
    env: &Env,
    policy: &PolicyV2,
    pool: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    prices: &mut Prices,
    auth: &mut Vec<InvokerContractAuthEntry>,
) -> Result<Option<i128>, Error> {
    if *fn_name == symbol_short!("deposit") {
        vault_arg(env, args, 0)?;
        let amounts: Vec<u128> = arg(env, args, 1, Error::InvalidAmount)?;
        let tokens = tokens(env, pool)?;
        if amounts.len() != tokens.len() {
            return Err(Error::InvalidAmount);
        }
        let mut committed: i128 = 0;
        for (token, amount) in tokens.iter().zip(amounts.iter()) {
            let amount = signed(amount)?;
            if amount == 0 {
                continue;
            }
            require_allowed(policy, &token)?;
            committed = add(committed, prices.value(env, &token, amount)?.unwrap_or(0))?;
            auth.push_back(transfer(env, &token, pool, amount));
        }
        Ok(Some(committed))
    } else if *fn_name == symbol_short!("withdraw") {
        vault_arg(env, args, 0)?;
        let shares = signed(arg(env, args, 1, Error::InvalidAmount)?)?;
        if shares > 0 {
            auth.push_back(burn(env, &share_token(env, pool), shares));
        }
        Ok(Some(0))
    } else {
        Ok(None)
    }
}

fn burn(env: &Env, share_token: &Address, amount: i128) -> InvokerContractAuthEntry {
    entry(
        env,
        share_token,
        symbol_short!("burn"),
        (env.current_contract_address(), amount).into_val(env),
    )
}

pub(crate) fn unwind(env: &Env, pool: &Address, shares: i128, supply: i128) -> Result<(), Error> {
    let part = mul_div(env, lp_balance(env, pool)?, shares, supply, false)?;
    if part == 0 {
        return Ok(());
    }
    env.authorize_as_current_contract(vec![env, burn(env, &share_token(env, pool), part)]);
    let _: Val = env.invoke_contract(
        pool,
        &symbol_short!("withdraw"),
        (
            env.current_contract_address(),
            part as u128,
            vec![env, 0_u128, 0_u128],
        )
            .into_val(env),
    );
    Ok(())
}
