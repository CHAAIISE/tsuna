use policy_registry::PolicyV2;
use soroban_sdk::{
    auth::InvokerContractAuthEntry, contracttype, symbol_short, vec, Address, Env, IntoVal, Map,
    Symbol, TryFromVal, Val, Vec,
};

use super::{add, arg, need, require_allowed, transfer, vault_arg, Holding, Needs};
use crate::{oracle::Prices, shares::mul_div, Error, Key, BPS};

/// Rounding of one pro-rata repayment against XOXNO's half-up debt display.
const MARGIN: i128 = 2;

/// A market: the same token on two liquidity hubs is two markets.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HubAssetKey {
    pub asset: Address,
    pub hub_id: u32,
}

/// The vault's lending account (position NFT id), if it is still open.
fn account(env: &Env, controller: &Address) -> Option<u64> {
    let id: u64 = env
        .storage()
        .instance()
        .get(&Key::Account(controller.clone()))?;
    let open: bool = env.invoke_contract(
        controller,
        &Symbol::new(env, "account_exists"),
        vec![env, id.into_val(env)],
    );
    open.then_some(id)
}

type Positions = (Map<HubAssetKey, Map<Symbol, Val>>, Map<HubAssetKey, Val>);

fn positions(env: &Env, controller: &Address, id: u64) -> Positions {
    env.invoke_contract(
        controller,
        &Symbol::new(env, "get_account_positions"),
        vec![env, id.into_val(env)],
    )
}

fn amount(
    env: &Env,
    controller: &Address,
    view: &str,
    id: u64,
    key: &HubAssetKey,
) -> Result<i128, Error> {
    let amount: i128 = env.invoke_contract(
        controller,
        &Symbol::new(env, view),
        (id, key.clone()).into_val(env),
    );
    if amount < 0 {
        return Err(Error::BadAdapterData);
    }
    Ok(amount)
}

/// Collateral at oracle prices weighted by each market's liquidation threshold, against debt.
pub(crate) fn value(
    env: &Env,
    controller: &Address,
    prices: &mut Prices,
) -> Result<Option<Holding>, Error> {
    let mut total = Holding::default();
    let Some(id) = account(env, controller) else {
        return Ok(Some(total));
    };
    let (collateral, debts) = positions(env, controller, id);
    for (key, position) in collateral.iter() {
        let supplied = amount(env, controller, "get_collateral_amount", id, &key)?;
        let threshold: u32 = u32::try_from_val(
            env,
            &position
                .get(Symbol::new(env, "liquidation_threshold"))
                .ok_or(Error::BadAdapterData)?,
        )
        .map_err(|_| Error::BadAdapterData)?;
        if i128::from(threshold) > BPS {
            return Err(Error::BadAdapterData);
        }
        let weighted = mul_div(env, supplied, threshold.into(), BPS, false)?;
        let (Some(gross), Some(weighted_collateral)) = (
            prices.value(env, &key.asset, supplied)?,
            prices.value(env, &key.asset, weighted)?,
        ) else {
            return Ok(None);
        };
        total.add(&Holding {
            gross,
            weighted_collateral,
            ..Holding::default()
        })?;
    }
    for key in debts.keys() {
        let owed = amount(env, controller, "get_borrow_amount", id, &key)?;
        let Some(debt) = prices.debt(env, &key.asset, owed)? else {
            return Ok(None);
        };
        total.add(&Holding {
            debt,
            weighted_debt: debt,
            ..Holding::default()
        })?;
    }
    Ok(Some(total))
}

/// Calls must target the vault's own account; `0` opens it when the vault has none, since a
/// second account would be invisible to the NAV.
fn own_account(
    env: &Env,
    controller: &Address,
    requested: u64,
    opening: bool,
) -> Result<(), Error> {
    match account(env, controller) {
        Some(id) if id == requested => Ok(()),
        None if opening && requested == 0 => Ok(()),
        _ => Err(Error::DestinationNotVault),
    }
}

/// `to: Option<Address>` defaults to the caller; anything else must be the vault.
fn payout(env: &Env, args: &Vec<Val>, index: u32) -> Result<(), Error> {
    let to: Option<Address> = arg(env, args, index, Error::DestinationNotVault)?;
    match to {
        Some(to) if to != env.current_contract_address() => Err(Error::DestinationNotVault),
        _ => Ok(()),
    }
}

/// `supply`/`repay` pull each amount from the caller into the central pool with `transfer`,
/// authorized here exactly; `withdraw`/`borrow` pay the vault only.
pub(crate) fn prepare(
    env: &Env,
    policy: &PolicyV2,
    controller: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    prices: &mut Prices,
    auth: &mut Vec<InvokerContractAuthEntry>,
) -> Result<Option<i128>, Error> {
    let (pays, assets_at) = if *fn_name == symbol_short!("supply") {
        (true, 3)
    } else if *fn_name == symbol_short!("repay") {
        (true, 2)
    } else if *fn_name == symbol_short!("withdraw") || *fn_name == symbol_short!("borrow") {
        (false, 2)
    } else {
        return Ok(None);
    };
    vault_arg(env, args, 0)?;
    let requested: u64 = arg(env, args, 1, Error::DestinationNotVault)?;
    own_account(
        env,
        controller,
        requested,
        *fn_name == symbol_short!("supply"),
    )?;
    if !pays {
        payout(env, args, 3)?;
    }
    let legs: Vec<(HubAssetKey, i128)> = arg(env, args, assets_at, Error::InvalidAmount)?;
    let pool: Option<Address> = pays.then(|| {
        env.invoke_contract(
            controller,
            &Symbol::new(env, "get_pool_address"),
            Vec::new(env),
        )
    });
    let mut committed: i128 = 0;
    for (key, amount) in legs.iter() {
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        require_allowed(policy, &key.asset)?;
        committed = add(
            committed,
            prices.value(env, &key.asset, amount)?.unwrap_or(0),
        )?;
        if let (Some(pool), true) = (&pool, amount > 0) {
            auth.push_back(transfer(env, &key.asset, pool, amount));
        }
    }
    Ok(Some(committed))
}

/// Remembers the account a first supply opened.
pub(crate) fn settle(
    env: &Env,
    controller: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    out: &Val,
) -> Result<(), Error> {
    if *fn_name != symbol_short!("supply") || arg::<u64>(env, args, 1, Error::BadAdapterData)? != 0
    {
        return Ok(());
    }
    let id = u64::try_from_val(env, out).map_err(|_| Error::BadAdapterData)?;
    env.storage()
        .instance()
        .set(&Key::Account(controller.clone()), &id);
    Ok(())
}

/// Repayment comes first and is never netted against releases.
pub(crate) fn needs(env: &Env, controller: &Address, needs: &mut Needs) -> Result<(), Error> {
    let Some(id) = account(env, controller) else {
        return Ok(());
    };
    for key in positions(env, controller, id).1.keys() {
        let owed = amount(env, controller, "get_borrow_amount", id, &key)?;
        if owed > 0 {
            need(needs, &key.asset, owed, MARGIN)?;
        }
    }
    Ok(())
}

pub(crate) fn unwind(
    env: &Env,
    controller: &Address,
    shares: i128,
    supply: i128,
) -> Result<(), Error> {
    let Some(id) = account(env, controller) else {
        return Ok(());
    };
    let me = env.current_contract_address();
    let (collateral, debts) = positions(env, controller, id);
    let mut payments: Vec<(HubAssetKey, i128)> = Vec::new(env);
    let mut auth = Vec::new(env);
    let mut pool: Option<Address> = None;
    for key in debts.keys() {
        let owed = amount(env, controller, "get_borrow_amount", id, &key)?;
        let part = mul_div(env, owed, shares, supply, true)?;
        if part > 0 {
            let pool = pool.get_or_insert_with(|| {
                env.invoke_contract(
                    controller,
                    &Symbol::new(env, "get_pool_address"),
                    Vec::new(env),
                )
            });
            auth.push_back(transfer(env, &key.asset, pool, part));
            payments.push_back((key, part));
        }
    }
    if !payments.is_empty() {
        env.authorize_as_current_contract(auth);
        let _: Val = env.invoke_contract(
            controller,
            &symbol_short!("repay"),
            (me.clone(), id, payments).into_val(env),
        );
    }
    let mut withdrawals: Vec<(HubAssetKey, i128)> = Vec::new(env);
    for key in collateral.keys() {
        let supplied = amount(env, controller, "get_collateral_amount", id, &key)?;
        // A zero amount would mean "withdraw everything" to XOXNO.
        let part = mul_div(env, supplied, shares, supply, false)?;
        if part > 0 {
            withdrawals.push_back((key, part));
        }
    }
    if !withdrawals.is_empty() {
        let _: Val = env.invoke_contract(
            controller,
            &symbol_short!("withdraw"),
            (me, id, withdrawals, Option::<Address>::None).into_val(env),
        );
    }
    Ok(())
}
