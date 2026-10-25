use policy_registry::PolicyV2;
use soroban_sdk::{
    auth::InvokerContractAuthEntry, symbol_short, vec, Address, Env, IntoVal, Map, Symbol,
    TryFromVal, Val, Vec,
};

use super::{add, arg, require_allowed, transfer, vault_arg, Holding};
use crate::{oracle::Prices, shares::mul_div, Error};

fn shares(env: &Env, vault: &Address) -> i128 {
    env.invoke_contract(
        vault,
        &symbol_short!("balance"),
        vec![env, env.current_contract_address().into_val(env)],
    )
}

/// The DeFindex vault's assets, in the order of its amount vectors.
fn assets(env: &Env, vault: &Address) -> Result<Vec<Address>, Error> {
    let sets: Vec<Map<Symbol, Val>> =
        env.invoke_contract(vault, &Symbol::new(env, "get_assets"), Vec::new(env));
    let mut out = Vec::new(env);
    for set in sets {
        let address = set
            .get(symbol_short!("address"))
            .ok_or(Error::BadAdapterData)?;
        out.push_back(Address::try_from_val(env, &address).map_err(|_| Error::BadAdapterData)?);
    }
    Ok(out)
}

/// Shares held × the vault's own redemption amounts per asset, at oracle prices.
pub(crate) fn value(
    env: &Env,
    vault: &Address,
    prices: &mut Prices,
) -> Result<Option<Holding>, Error> {
    let shares = shares(env, vault);
    if shares < 0 {
        return Err(Error::BadAdapterData);
    }
    if shares == 0 {
        return Ok(Some(Holding::default()));
    }
    let amounts: Vec<i128> = env.invoke_contract(
        vault,
        &Symbol::new(env, "get_asset_amounts_per_shares"),
        vec![env, shares.into_val(env)],
    );
    let assets = assets(env, vault)?;
    if amounts.len() != assets.len() {
        return Err(Error::BadAdapterData);
    }
    let mut gross: i128 = 0;
    for (asset, amount) in assets.iter().zip(amounts.iter()) {
        if amount < 0 {
            return Err(Error::BadAdapterData);
        }
        let Some(value) = prices.value(env, &asset, amount)? else {
            return Ok(None);
        };
        gross = add(gross, value)?;
    }
    Ok(Some(Holding {
        gross,
        ..Holding::default()
    }))
}

/// `deposit(amounts_desired, amounts_min, from, invest)` pulls each amount from `from` with
/// `transfer`, which the vault authorizes exactly once per asset.
pub(crate) fn prepare(
    env: &Env,
    policy: &PolicyV2,
    vault: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    prices: &mut Prices,
    auth: &mut Vec<InvokerContractAuthEntry>,
) -> Result<Option<i128>, Error> {
    if *fn_name != symbol_short!("deposit") {
        return Ok(None);
    }
    vault_arg(env, args, 2)?;
    let amounts: Vec<i128> = arg(env, args, 0, Error::InvalidAmount)?;
    let assets = assets(env, vault)?;
    if amounts.len() != assets.len() {
        return Err(Error::InvalidAmount);
    }
    let mut committed: i128 = 0;
    for (asset, amount) in assets.iter().zip(amounts.iter()) {
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        if amount == 0 {
            continue;
        }
        require_allowed(policy, &asset)?;
        committed = add(committed, prices.value(env, &asset, amount)?.unwrap_or(0))?;
        auth.push_back(transfer(env, &asset, vault, amount));
    }
    Ok(Some(committed))
}

pub(crate) fn unwind(env: &Env, vault: &Address, shares: i128, supply: i128) -> Result<(), Error> {
    let part = mul_div(env, self::shares(env, vault), shares, supply, false)?;
    if part == 0 {
        return Ok(());
    }
    let mut minimums = Vec::new(env);
    for _ in assets(env, vault)? {
        minimums.push_back(0_i128);
    }
    let _: Val = env.invoke_contract(
        vault,
        &symbol_short!("withdraw"),
        (part, minimums, env.current_contract_address()).into_val(env),
    );
    Ok(())
}
