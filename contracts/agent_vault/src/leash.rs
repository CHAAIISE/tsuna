use policy_registry::{ArgRule, CallRule, Limits, PolicyV2};
use soroban_sdk::{
    contracttype, symbol_short, vec, Address, Env, IntoVal, Symbol, TryFromVal, Val, Vec,
};

use crate::{adapters::blend::Request, shares, Error, Key, BPS};

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
    /// Base-asset amount charged to the transaction and daily budgets.
    pub value: i128,
    /// Net base-asset amount the target may pull from the vault.
    pub pull: i128,
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
        Some(policy) => policy.assets,
        None => vec![env, env.storage().instance().get(&Key::Asset).unwrap()],
    }
}

pub(crate) fn inspect(
    env: &Env,
    policy: &PolicyV2,
    target: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
) -> Result<Call, Error> {
    let rule = policy.rule(target, fn_name).ok_or(Error::CallNotAllowed)?;
    if rule.args.len() != args.len() {
        return Err(Error::ArgCountMismatch);
    }
    let me = env.current_contract_address();
    let allowed = &policy.assets;
    let mut spenders = Vec::from_array(env, [target.clone()]);
    let mut value: i128 = 0;
    let mut pull: i128 = 0;
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
                pull = add(pull, amount)?;
            }
            ArgRule::BlendRequests => {
                let requests =
                    Vec::<Request>::try_from_val(env, &arg).map_err(|_| Error::InvalidAmount)?;
                let asset = allowed.get_unchecked(0);
                let (mut inflow, mut outflow) = (0_i128, 0_i128);
                for request in requests {
                    if !allowed.contains(&request.address) {
                        return Err(Error::AssetNotAllowed);
                    }
                    // Blend positions are valued in the base asset only.
                    if request.address != asset || request.request_type > 5 || request.amount < 0 {
                        return Err(Error::InvalidAmount);
                    }
                    value = add(value, request.amount)?;
                    match request.request_type {
                        0 | 2 | 5 => inflow = add(inflow, request.amount)?,
                        _ => outflow = add(outflow, request.amount)?,
                    }
                }
                // Blend nets transfers per token, so it pulls only the excess inflow.
                pull = add(pull, (inflow - outflow).max(0))?;
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
        pull,
        spenders,
    })
}

pub(crate) fn charge(env: &Env, limits: &Limits, amount: i128, nav: i128) -> Result<(), Error> {
    if amount > shares::mul_div(env, nav, limits.tx_cap_bps.into(), BPS, false)? {
        return Err(Error::TxCapExceeded);
    }
    let now = env.ledger().timestamp();
    let mut usage = usage(env);
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
    env.storage().instance().set(&Key::Usage, &usage);
    Ok(())
}

pub(crate) fn usage(env: &Env) -> Usage {
    env.storage().instance().get(&Key::Usage).unwrap_or(Usage {
        day: env.ledger().timestamp() / 86_400,
        spent: 0,
        hour: env.ledger().timestamp() / 3_600,
        calls: 0,
    })
}

/// Losses still inside the rolling 24 h window, in hourly buckets (at most 24).
fn window(env: &Env) -> Vec<LossBucket> {
    let hour = env.ledger().timestamp() / 3_600;
    let mut kept = Vec::new(env);
    let buckets: Vec<LossBucket> = env
        .storage()
        .instance()
        .get(&Key::Losses)
        .unwrap_or(Vec::new(env));
    for bucket in buckets {
        if bucket.hour + 24 > hour {
            kept.push_back(bucket);
        }
    }
    kept
}

pub(crate) fn daily_loss(env: &Env) -> Result<i128, Error> {
    window(env)
        .iter()
        .try_fold(0_i128, |total, bucket| add(total, bucket.loss))
}

/// Many small losses each under the per-call tolerance must not add up to a large one.
pub(crate) fn record_loss(
    env: &Env,
    limits: &Limits,
    loss: i128,
    nav_before: i128,
) -> Result<(), Error> {
    if loss <= 0 {
        return Ok(());
    }
    let hour = env.ledger().timestamp() / 3_600;
    let mut buckets = window(env);
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
    env.storage().instance().set(&Key::Losses, &buckets);
    Ok(())
}

fn add(a: i128, b: i128) -> Result<i128, Error> {
    a.checked_add(b).ok_or(Error::ArithmeticOverflow)
}
