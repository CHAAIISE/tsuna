use soroban_sdk::{contracttype, Address, Env, Symbol, TryFromVal, Val, Vec};

use crate::{adapters::blend::Request, shares, AgentVault, ArgRule, Error, Key, BPS};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Limits {
    pub tx_cap_bps: u32,
    pub daily_cap_bps: u32,
    pub calls_per_hour: u32,
    pub min_health_factor_bps: u32,
    pub max_drawdown_bps: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            tx_cap_bps: 10_000,
            daily_cap_bps: 100_000,
            calls_per_hour: 60,
            min_health_factor_bps: 13_000,
            max_drawdown_bps: 2_000,
        }
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Usage {
    pub day: u64,
    pub spent: i128,
    pub hour: u64,
    pub calls: u32,
}

pub(crate) fn limits(env: &Env) -> Limits {
    env.storage().instance().get(&Key::Limits).unwrap()
}

pub(crate) fn validate(limits: &Limits) -> Result<(), Error> {
    if limits.tx_cap_bps > 10_000
        || limits.daily_cap_bps == 0
        || limits.calls_per_hour == 0
        || limits.min_health_factor_bps < 10_000
        || limits.max_drawdown_bps > 10_000
    {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

pub(crate) fn amount(
    env: &Env,
    target: &Address,
    fn_name: &Symbol,
    args: &Vec<Val>,
) -> Result<i128, Error> {
    let rules: Vec<ArgRule> = env
        .storage()
        .persistent()
        .get(&Key::Rule(target.clone(), fn_name.clone()))
        .ok_or(Error::CallNotAllowed)?;
    if rules.len() != args.len() {
        return Err(Error::ArgCountMismatch);
    }
    let me = env.current_contract_address();
    let mut total: i128 = 0;
    for (rule, arg) in rules.iter().zip(args.iter()) {
        let value = match rule {
            ArgRule::Any => 0,
            ArgRule::Vault => {
                if Address::try_from_val(env, &arg).map_err(|_| Error::DestinationNotVault)? != me {
                    return Err(Error::DestinationNotVault);
                }
                0
            }
            ArgRule::Protocol => {
                let address =
                    Address::try_from_val(env, &arg).map_err(|_| Error::SpenderNotProtocol)?;
                if !AgentVault::is_protocol(env, &address) {
                    return Err(Error::SpenderNotProtocol);
                }
                0
            }
            ArgRule::Amount => i128::try_from_val(env, &arg).map_err(|_| Error::InvalidAmount)?,
            ArgRule::BlendRequests => {
                let requests =
                    Vec::<Request>::try_from_val(env, &arg).map_err(|_| Error::InvalidAmount)?;
                let asset: Address = env.storage().instance().get(&Key::Asset).unwrap();
                let mut value: i128 = 0;
                for request in requests {
                    if request.address != asset || request.request_type > 5 || request.amount < 0 {
                        return Err(Error::InvalidAmount);
                    }
                    value = value
                        .checked_add(request.amount)
                        .ok_or(Error::ArithmeticOverflow)?;
                }
                value
            }
        };
        if value < 0 {
            return Err(Error::InvalidAmount);
        }
        total = total.checked_add(value).ok_or(Error::ArithmeticOverflow)?;
    }
    Ok(total)
}

pub(crate) fn charge(env: &Env, amount: i128, nav: i128) -> Result<(), Error> {
    let limits = limits(env);
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
    usage.spent = usage
        .spent
        .checked_add(amount)
        .ok_or(Error::ArithmeticOverflow)?;
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
