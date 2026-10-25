use soroban_sdk::{Address, Map, Symbol, Vec};

use crate::{
    ArgRule, CallRule, Error, Limits, PolicyV2, Quota, Role, BPS, DEFAULT_ROLE, MAX_ASSETS,
    MAX_CALLS, MAX_GUARDS, MAX_PROTOCOLS, MAX_ROLES, MAX_ROLE_CALLS,
};

pub(crate) fn validate(policy: &PolicyV2, base: &Address) -> Result<(), Error> {
    let limits = &policy.limits;
    let limits_valid = limits.tx_cap_bps <= BPS
        && limits.daily_cap_bps != 0
        && limits.calls_per_hour != 0
        && limits.min_health_factor_bps >= BPS
        && limits.max_drawdown_bps <= BPS
        && limits.daily_loss_bps <= BPS
        && limits.max_exposure_bps != 0
        && limits.max_exposure_bps <= BPS;
    let caps_valid = policy.exposure_caps.as_ref().is_none_or(|caps| {
        caps.len() <= MAX_PROTOCOLS && caps.values().iter().all(|cap| cap <= BPS)
    });
    if !limits_valid
        || !caps_valid
        || !roles_valid(policy)
        || policy.assets.get(0).as_ref() != Some(base)
        || policy.assets.len() > MAX_ASSETS
        || policy.protocols.len() > MAX_PROTOCOLS
        || policy.calls.len() > MAX_CALLS
        || policy
            .calls
            .values()
            .iter()
            .any(|rule| rule.max_loss_bps > BPS)
        || policy.guards.len() > MAX_PROTOCOLS
        || policy
            .guards
            .values()
            .iter()
            .any(|list| list.len() > MAX_GUARDS)
    {
        return Err(Error::InvalidPolicy);
    }
    Ok(())
}

/// True when `next` grants anything `current` does not, field by field.
/// A change that tightens some fields and loosens others is a loosening.
pub(crate) fn loosens(current: &PolicyV2, next: &PolicyV2) -> bool {
    added(&current.protocols, &next.protocols)
        || added(&current.assets, &next.assets)
        || calls_loosen(&current.calls, &next.calls)
        || next.guards.iter().any(|(protocol, guards)| {
            current
                .guards
                .get(protocol)
                .map_or(!guards.is_empty(), |old| added(&old, &guards))
        })
        || limits_loosen(&current.limits, &next.limits)
        || exposure_loosens(current, next)
        || roles_loosen(current, next)
}

/// `default` is the vault's own session key, rules and limits; it cannot be redefined as a role.
fn roles_valid(policy: &PolicyV2) -> bool {
    let Some(roles) = policy.roles.as_ref() else {
        return true;
    };
    let default = Symbol::new(roles.env(), DEFAULT_ROLE);
    roles.len() <= MAX_ROLES
        && roles.iter().all(|(name, role)| {
            let quota = &role.quota;
            name != default
                && role.calls.len() <= MAX_ROLE_CALLS
                && role
                    .calls
                    .values()
                    .iter()
                    .all(|rule| rule.max_loss_bps <= BPS)
                && quota.tx_cap_bps <= BPS
                && quota.daily_cap_bps != 0
                && quota.calls_per_hour != 0
                && quota.daily_loss_bps <= BPS
        })
}

fn calls_loosen(
    current: &Map<(Address, Symbol), CallRule>,
    next: &Map<(Address, Symbol), CallRule>,
) -> bool {
    next.iter().any(|(call, rule)| {
        current
            .get(call)
            .is_none_or(|old| rule_loosens(&old, &rule))
    })
}

/// Adding a role or widening one loosens; removing or narrowing one tightens.
fn roles_loosen(current: &PolicyV2, next: &PolicyV2) -> bool {
    next.roles.as_ref().is_some_and(|roles| {
        roles.iter().any(|(name, role)| {
            current
                .role(&name)
                .is_none_or(|old| role_loosens(&old, &role))
        })
    })
}

fn role_loosens(current: &Role, next: &Role) -> bool {
    next.member != current.member
        // RiskOff acts while paused and Normal may raise risk: either switch grants something.
        || next.mode != current.mode
        || calls_loosen(&current.calls, &next.calls)
        || quota_loosens(&current.quota, &next.quota)
}

fn quota_loosens(current: &Quota, next: &Quota) -> bool {
    next.tx_cap_bps > current.tx_cap_bps
        || next.daily_cap_bps > current.daily_cap_bps
        || next.calls_per_hour > current.calls_per_hour
        || next.daily_loss_bps > current.daily_loss_bps
}

fn added(current: &Vec<Address>, next: &Vec<Address>) -> bool {
    next.iter().any(|address| !current.contains(&address))
}

fn rule_loosens(current: &CallRule, next: &CallRule) -> bool {
    next.max_loss_bps > current.max_loss_bps
        || (next.approve && !current.approve)
        || next.args.len() != current.args.len()
        // Constraining an `Any` argument tightens; any other change swaps one check for another.
        || current
            .args
            .iter()
            .zip(next.args.iter())
            .any(|(old, new)| old != new && old != ArgRule::Any)
}

fn limits_loosen(current: &Limits, next: &Limits) -> bool {
    next.tx_cap_bps > current.tx_cap_bps
        || next.daily_cap_bps > current.daily_cap_bps
        || next.calls_per_hour > current.calls_per_hour
        || next.min_health_factor_bps < current.min_health_factor_bps
        || next.max_drawdown_bps > current.max_drawdown_bps
        || next.daily_loss_bps > current.daily_loss_bps
        || next.max_exposure_bps > current.max_exposure_bps
}

/// Compares the effective cap of every protocol with an override on either side;
/// protocols without one follow `max_exposure_bps`, compared in [`limits_loosen`].
fn exposure_loosens(current: &PolicyV2, next: &PolicyV2) -> bool {
    [&current.exposure_caps, &next.exposure_caps]
        .into_iter()
        .flatten()
        .any(|caps| {
            caps.keys()
                .iter()
                .any(|protocol| next.exposure_cap(&protocol) > current.exposure_cap(&protocol))
        })
}
