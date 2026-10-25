//! Agent roles. Each named role has its own member, allowlist and quotas on top of the vault's
//! protocols, guards and assets. A RiskOff role may act while the vault is paused, because
//! every call it makes is checked on its outcome: the vault must end no riskier than it was.

use policy_registry::{Limits, PolicyV2, RoleMode, DEFAULT_ROLE};
use soroban_sdk::{Address, Env, Symbol, Vec};

use crate::{leash, AgentVault, Error, Valuation};

/// Who acts, and the rules that apply.
pub(crate) struct Scope {
    /// `None` for the default role.
    pub name: Option<Symbol>,
    pub mode: RoleMode,
    /// The vault policy with the role's allowlist and quotas in place of the default ones.
    pub policy: PolicyV2,
}

/// Name under which `role`'s budgets are counted: `None` for the default role.
pub(crate) fn counters(env: &Env, role: &Symbol) -> Option<Symbol> {
    (*role != Symbol::new(env, DEFAULT_ROLE)).then(|| role.clone())
}

/// The session key's role: the policy's own `calls` and `limits`, blocked while paused.
pub(crate) fn default_scope(env: &Env) -> Result<Scope, Error> {
    if AgentVault::paused(env.clone()) {
        return Err(Error::Paused);
    }
    Ok(Scope {
        name: None,
        mode: RoleMode::Normal,
        policy: leash::rules(env)?,
    })
}

pub(crate) fn named(env: &Env, member: &Address, name: Symbol) -> Result<Scope, Error> {
    let policy = leash::rules(env)?;
    let role = policy.role(&name).ok_or(Error::RoleNotFound)?;
    if role.member != *member {
        return Err(Error::NotRoleMember);
    }
    if role.mode == RoleMode::Normal && AgentVault::paused(env.clone()) {
        return Err(Error::Paused);
    }
    let limits = Limits {
        tx_cap_bps: role.quota.tx_cap_bps,
        daily_cap_bps: role.quota.daily_cap_bps,
        calls_per_hour: role.quota.calls_per_hour,
        daily_loss_bps: role.quota.daily_loss_bps,
        ..policy.limits.clone()
    };
    Ok(Scope {
        name: Some(name),
        mode: role.mode,
        policy: PolicyV2 {
            calls: role.calls,
            limits,
            ..policy
        },
    })
}

/// A RiskOff call that loses value, lets it leave the perimeter or leaves an allowance behind
/// made the vault riskier: it reports [`Error::RiskIncreased`] whatever guard caught it.
pub(crate) fn outcome(mode: RoleMode, result: Result<(), Error>) -> Result<(), Error> {
    match (mode, result) {
        (
            RoleMode::RiskOff,
            Err(Error::NavDropped | Error::ValueLeftPerimeter | Error::AllowanceNotCleared),
        ) => Err(Error::RiskIncreased),
        (_, result) => result,
    }
}

/// Compared at the prices of the same call, so a price move cannot pass for de-risking:
/// - the health factor does not fall (it is `i128::MAX` without debt);
/// - no protocol holds more than before, so no position opens or grows;
/// - idle non-base value grows at most by what positions released (within the call's loss
///   tolerance, which absorbs valuation rounding): value never leaves the base asset for
///   another one;
/// - an asset not held before appears only when a position released it.
pub(crate) fn risk_not_increased(
    before: &Valuation,
    after: &Valuation,
    held_before: &Vec<(Address, i128)>,
    held_after: &Vec<(Address, i128)>,
    tolerance: i128,
) -> Result<(), Error> {
    if after.health < before.health {
        return Err(Error::RiskIncreased);
    }
    let mut released: i128 = 0;
    for (protocol, value) in after.exposures.iter() {
        let previous = before
            .exposures
            .iter()
            .find(|(address, _)| *address == protocol)
            .map_or(0, |(_, value)| value);
        if value > previous {
            return Err(Error::RiskIncreased);
        }
        released = released
            .checked_add(previous - value)
            .ok_or(Error::ArithmeticOverflow)?;
    }
    if after.idle - before.idle > released.saturating_add(tolerance) {
        return Err(Error::RiskIncreased);
    }
    let new_asset = held_after
        .iter()
        .any(|(asset, _)| !held_before.iter().any(|(held, _)| held == asset));
    if new_asset && released == 0 {
        return Err(Error::RiskIncreased);
    }
    Ok(())
}
