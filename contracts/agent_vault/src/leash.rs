use policy_registry::{ArgRule, CallRule, Limits, PolicyV2};
use soroban_sdk::{
    contracttype, symbol_short, vec, Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

use crate::{adapters::blend::Request, oracle::Prices, shares, Error, Key, BPS};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Usage {
    pub day: u64,
    pub spent: i128,
    pub hour: u64,
    pub calls: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LossBucket {
    pub hour: u64,
    pub loss: i128,
}

/// What the pre-checks learned about one proposed call.
pub(crate) struct Call {
    pub rule: CallRule,
    /// Base-asset value charged to the transaction and daily budgets.
    pub value: i128,
    /// Net amount of each asset the target may pull from the vault.
    pub pulls: Map<Address, i128>,
    /// Every address that could hold an allowance from this call.
    pub spenders: Vec<Address>,
}

/// The vault's rules, owned by the policy registry; `None` until the creator registers them.
pub(crate) fn policy(env: &Env) -> Option<PolicyV2> {
    let registry: Address = env.storage().instance().get(&Key::Registry).unwrap();
    env.invoke_contract(
        &registry,
        &symbol_short!("policy"),
        vec![env, env.current_contract_address().into_val(env)],
    )
}

pub(crate) fn rules(env: &Env) -> Result<PolicyV2, Error> {
    policy(env).ok_or(Error::PolicyMissing)
}

/// Assets counted in NAV and paid out on withdrawal, base asset first.
pub(crate) fn assets(env: &Env) -> Vec<Address> {
    match policy(env) {
        Some(policy) => valued(env, &policy),
        None => vec![env, env.storage().instance().get(&Key::Asset).unwrap()],
    }
}

fn known(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&Key::KnownAssets)
        .unwrap_or(vec![env])
}

/// The policy's assets, then any asset an earlier policy listed and this one dropped.
/// Dropping an asset applies without a timelock; valuing only the current list would let the
/// creator hide holdings from NAV, deposit at the lower share price and list the asset again.
pub(crate) fn valued(env: &Env, policy: &PolicyV2) -> Vec<Address> {
    let mut assets = policy.assets.clone();
    for asset in known(env).iter() {
        if !assets.contains(&asset) {
            assets.push_back(asset);
        }
    }
    assets
}

/// `assets`, recording the policy's assets first: for entry points that change state.
pub(crate) fn sync(env: &Env) -> Vec<Address> {
    match policy(env) {
        Some(policy) => {
            remember(env, &policy);
            valued(env, &policy)
        }
        None => vec![env, env.storage().instance().get(&Key::Asset).unwrap()],
    }
}

/// Adds the policy's assets to the known ones; every state-changing entry point calls it.
pub(crate) fn remember(env: &Env, policy: &PolicyV2) {
    let mut known = known(env);
    let before = known.len();
    for asset in policy.assets.iter() {
        if !known.contains(&asset) {
            known.push_back(asset);
        }
    }
    if known.len() != before {
        env.storage().instance().set(&Key::KnownAssets, &known);
    }
}

pub(crate) fn inspect(
    env: &Env,
    policy: &PolicyV2,
    target: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
    prices: &mut Prices,
) -> Result<Call, Error> {
    let rule = policy.rule(target, fn_name).ok_or(Error::CallNotAllowed)?;
    if rule.args.len() != args.len() {
        return Err(Error::ArgCountMismatch);
    }
    let me = env.current_contract_address();
    let allowed = &policy.assets;
    let base = allowed.get_unchecked(0);
    let mut spenders = Vec::from_array(env, [target.clone()]);
    let mut value: i128 = 0;
    let mut pulls: Map<Address, i128> = Map::new(env);
    for (arg_rule, arg) in rule.args.iter().zip(args.iter()) {
        match arg_rule {
            ArgRule::Any => {}
            ArgRule::Vault => {
                if Address::try_from_val(env, &arg).map_err(|_| Error::DestinationNotVault)? != me {
                    return Err(Error::DestinationNotVault);
                }
            }
            ArgRule::Protocol => {
                let address =
                    Address::try_from_val(env, &arg).map_err(|_| Error::SpenderNotProtocol)?;
                if !policy.is_protocol(&address) {
                    return Err(Error::SpenderNotProtocol);
                }
                spenders.push_back(address);
            }
            ArgRule::Amount => {
                let amount = i128::try_from_val(env, &arg).map_err(|_| Error::InvalidAmount)?;
                if amount < 0 {
                    return Err(Error::InvalidAmount);
                }
                value = add(value, amount)?;
                pulls.set(
                    base.clone(),
                    add(pulls.get(base.clone()).unwrap_or(0), amount)?,
                );
            }
            ArgRule::BlendRequests => {
                let requests =
                    Vec::<Request>::try_from_val(env, &arg).map_err(|_| Error::InvalidAmount)?;
                let mut flows: Map<Address, (i128, i128)> = Map::new(env);
                for request in requests {
                    if !allowed.contains(&request.address) {
                        return Err(Error::AssetNotAllowed);
                    }
                    if request.request_type > 5 || request.amount < 0 {
                        return Err(Error::InvalidAmount);
                    }
                    // Valued like a debt: a reserve the oracle cannot price would be invisible
                    // to the NAV, so it is refused rather than budgeted at zero.
                    let worth = prices
                        .debt(env, &request.address, request.amount)?
                        .ok_or(Error::OracleUnavailable)?;
                    value = add(value, worth)?;
                    let (mut inflow, mut outflow) =
                        flows.get(request.address.clone()).unwrap_or((0, 0));
                    match request.request_type {
                        0 | 2 | 5 => inflow = add(inflow, request.amount)?,
                        _ => outflow = add(outflow, request.amount)?,
                    }
                    flows.set(request.address, (inflow, outflow));
                }
                // Blend nets transfers per token, so it pulls only each token's excess inflow.
                for (asset, (inflow, outflow)) in flows.iter() {
                    if inflow > outflow {
                        let pulled = pulls.get(asset.clone()).unwrap_or(0);
                        pulls.set(asset, add(pulled, inflow - outflow)?);
                    }
                }
            }
            ArgRule::Assets => {
                let list =
                    Vec::<Address>::try_from_val(env, &arg).map_err(|_| Error::AssetNotAllowed)?;
                for asset in list {
                    if !allowed.contains(&asset) {
                        return Err(Error::AssetNotAllowed);
                    }
                }
            }
        }
    }
    Ok(Call {
        rule,
        value,
        pulls,
        spenders,
    })
}

/// Counters of a named role, or of the default role for `None`.
fn usage_key(role: Option<&Symbol>) -> Key {
    role.map_or(Key::Usage, |role| Key::RoleUsage(role.clone()))
}

fn losses_key(role: Option<&Symbol>) -> Key {
    role.map_or(Key::Losses, |role| Key::RoleLosses(role.clone()))
}

pub(crate) fn charge(
    env: &Env,
    limits: &Limits,
    amount: i128,
    nav: i128,
    role: Option<&Symbol>,
) -> Result<(), Error> {
    if amount > shares::mul_div(env, nav, limits.tx_cap_bps.into(), BPS, false)? {
        return Err(Error::TxCapExceeded);
    }
    let now = env.ledger().timestamp();
    let mut usage = usage(env, role);
    if usage.day != now / 86_400 {
        usage.day = now / 86_400;
        usage.spent = 0;
    }
    if usage.hour != now / 3_600 {
        usage.hour = now / 3_600;
        usage.calls = 0;
    }
    usage.spent = add(usage.spent, amount)?;
    if usage.spent > shares::mul_div(env, nav, limits.daily_cap_bps.into(), BPS, false)? {
        return Err(Error::DailyCapExceeded);
    }
    if usage.calls >= limits.calls_per_hour {
        return Err(Error::RateLimited);
    }
    usage.calls += 1;
    // Written before the external call; a rejected post-condition rolls this back too.
    env.storage().instance().set(&usage_key(role), &usage);
    Ok(())
}

pub(crate) fn usage(env: &Env, role: Option<&Symbol>) -> Usage {
    env.storage()
        .instance()
        .get(&usage_key(role))
        .unwrap_or(Usage {
            day: env.ledger().timestamp() / 86_400,
            spent: 0,
            hour: env.ledger().timestamp() / 3_600,
            calls: 0,
        })
}

/// Losses still inside the rolling 24 h window, in hourly buckets (at most 24).
fn window(env: &Env, role: Option<&Symbol>) -> Vec<LossBucket> {
    let hour = env.ledger().timestamp() / 3_600;
    let mut kept = Vec::new(env);
    let buckets: Vec<LossBucket> = env
        .storage()
        .instance()
        .get(&losses_key(role))
        .unwrap_or(Vec::new(env));
    for bucket in buckets {
        if bucket.hour + 24 > hour {
            kept.push_back(bucket);
        }
    }
    kept
}

pub(crate) fn daily_loss(env: &Env, role: Option<&Symbol>) -> Result<i128, Error> {
    window(env, role)
        .iter()
        .try_fold(0_i128, |total, bucket| add(total, bucket.loss))
}

/// Many small losses each under the per-call tolerance must not add up to a large one.
pub(crate) fn record_loss(
    env: &Env,
    limits: &Limits,
    loss: i128,
    nav_before: i128,
    role: Option<&Symbol>,
) -> Result<(), Error> {
    if loss <= 0 {
        return Ok(());
    }
    let hour = env.ledger().timestamp() / 3_600;
    let mut buckets = window(env, role);
    let mut total = loss;
    for bucket in buckets.iter() {
        total = add(total, bucket.loss)?;
    }
    let budget = shares::mul_div(env, nav_before, limits.daily_loss_bps.into(), BPS, false)?;
    if total > budget {
        return Err(Error::DailyLossExceeded);
    }
    match buckets.last() {
        Some(mut last) if last.hour == hour => {
            last.loss = add(last.loss, loss)?;
            buckets.set(buckets.len() - 1, last);
        }
        _ => buckets.push_back(LossBucket { hour, loss }),
    }
    env.storage().instance().set(&losses_key(role), &buckets);
    Ok(())
}

fn add(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}
