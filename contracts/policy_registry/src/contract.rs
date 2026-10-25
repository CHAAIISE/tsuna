use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address, Env,
    IntoVal, Map, Symbol, TryFromVal, Val, Vec,
};

use crate::{rules, PolicyV2, Role};

const TTL_THRESHOLD: u32 = 17_280;
const TTL_EXTEND_TO: u32 = 120_960;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotRegistered = 1,
    AlreadyRegistered = 2,
    InvalidPolicy = 3,
    /// An initial policy installed after deposits would bypass the timelock.
    VaultHasDeposits = 4,
    NoPendingPolicy = 5,
    TimelockActive = 6,
    RoleNotFound = 7,
}

#[contracttype]
pub(crate) enum Key {
    Timelock,
    Creator(Address),
    Policy(Address),
    Pending(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingPolicy {
    pub policy: PolicyV2,
    /// Earliest ledger timestamp at which `apply_policy` succeeds.
    pub eta: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicyChange {
    /// Nothing was loosened; the policy is already in force.
    Tightened,
    /// At least one field was loosened; applicable from the given timestamp.
    Proposed(u64),
}

#[contractevent]
pub struct PolicyRegistered {
    #[topic]
    pub vault: Address,
    pub creator: Address,
}

#[contractevent]
pub struct PolicyTightened {
    #[topic]
    pub vault: Address,
}

#[contractevent]
pub struct PolicyProposed {
    #[topic]
    pub vault: Address,
    pub eta: u64,
}

#[contractevent]
pub struct PolicyApplied {
    #[topic]
    pub vault: Address,
}

/// A role was added or widened; it becomes usable after `apply_policy` at `eta`.
#[contractevent]
pub struct RoleProposed {
    #[topic]
    pub vault: Address,
    #[topic]
    pub role: Symbol,
    pub eta: u64,
}

#[contractevent]
pub struct RoleNarrowed {
    #[topic]
    pub vault: Address,
    #[topic]
    pub role: Symbol,
}

#[contractevent]
pub struct RoleRevoked {
    #[topic]
    pub vault: Address,
    #[topic]
    pub role: Symbol,
}

/// A role added or changed by the applied policy.
#[contractevent]
pub struct RoleApplied {
    #[topic]
    pub vault: Address,
    #[topic]
    pub role: Symbol,
}

/// Rules of each vault, changed by the vault's creator. Tightening is immediate;
/// loosening is public for `policy_timelock` seconds first, so depositors can leave.
#[contract]
pub struct PolicyRegistry;

#[contractimpl]
impl PolicyRegistry {
    pub fn __constructor(env: Env, timelock: u64) {
        env.storage().instance().set(&Key::Timelock, &timelock);
    }

    pub fn policy_timelock(env: Env) -> u64 {
        env.storage().instance().get(&Key::Timelock).unwrap()
    }

    /// Installs the first policy of `vault`, signed by the vault's owner, before any deposit.
    pub fn register(env: Env, vault: Address, policy: PolicyV2) -> Result<(), Error> {
        let creator_key = Key::Creator(vault.clone());
        if env.storage().persistent().has(&creator_key) {
            return Err(Error::AlreadyRegistered);
        }
        let creator: Address = view(&env, &vault, symbol_short!("owner"));
        creator.require_auth();
        if view::<i128>(&env, &vault, Symbol::new(&env, "total_shares")) != 0 {
            return Err(Error::VaultHasDeposits);
        }
        rules::validate(&policy, &view(&env, &vault, symbol_short!("asset")))?;
        store(&env, &creator_key, &creator);
        store(&env, &Key::Policy(vault.clone()), &policy);
        PolicyRegistered { vault, creator }.publish(&env);
        Ok(())
    }

    pub fn creator(env: Env, vault: Address) -> Option<Address> {
        load(&env, &Key::Creator(vault))
    }

    pub fn policy(env: Env, vault: Address) -> Option<PolicyV2> {
        load(&env, &Key::Policy(vault))
    }

    pub fn pending_policy(env: Env, vault: Address) -> Option<PendingPolicy> {
        load(&env, &Key::Pending(vault))
    }

    /// A change that only tightens applies now and supersedes any pending loosening.
    /// Otherwise it replaces the pending proposal and restarts the timelock.
    pub fn propose_policy(
        env: Env,
        vault: Address,
        policy: PolicyV2,
    ) -> Result<PolicyChange, Error> {
        Self::creator_of(&env, &vault)?.require_auth();
        change(&env, vault, policy)
    }

    /// Sets role `name` on top of the policy in force, classified like `propose_policy`:
    /// adding or widening a role waits for the timelock, narrowing it applies now.
    pub fn propose_role(
        env: Env,
        vault: Address,
        name: Symbol,
        role: Role,
    ) -> Result<PolicyChange, Error> {
        Self::creator_of(&env, &vault)?.require_auth();
        let mut policy = current(&env, &vault)?;
        let mut roles = policy.roles.clone().unwrap_or(Map::new(&env));
        roles.set(name.clone(), role);
        policy.roles = Some(roles);
        let outcome = change(&env, vault.clone(), policy)?;
        match outcome {
            PolicyChange::Proposed(eta) => RoleProposed {
                vault,
                role: name,
                eta,
            }
            .publish(&env),
            PolicyChange::Tightened => RoleNarrowed { vault, role: name }.publish(&env),
        }
        Ok(outcome)
    }

    /// Immediate, like any tightening, so a leaked member key is cut off in one transaction.
    pub fn revoke_role(env: Env, vault: Address, name: Symbol) -> Result<(), Error> {
        Self::creator_of(&env, &vault)?.require_auth();
        let mut policy = current(&env, &vault)?;
        let mut roles = policy.roles.clone().ok_or(Error::RoleNotFound)?;
        if roles.remove(name.clone()).is_none() {
            return Err(Error::RoleNotFound);
        }
        policy.roles = Some(roles);
        change(&env, vault.clone(), policy)?;
        RoleRevoked { vault, role: name }.publish(&env);
        Ok(())
    }

    pub fn apply_policy(env: Env, vault: Address) -> Result<(), Error> {
        Self::creator_of(&env, &vault)?.require_auth();
        let key = Key::Pending(vault.clone());
        let pending: PendingPolicy = load(&env, &key).ok_or(Error::NoPendingPolicy)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockActive);
        }
        let previous = current(&env, &vault)?;
        env.storage().persistent().remove(&key);
        store(&env, &Key::Policy(vault.clone()), &pending.policy);
        PolicyApplied {
            vault: vault.clone(),
        }
        .publish(&env);
        for (name, role) in pending.policy.roles.unwrap_or(Map::new(&env)) {
            if previous.role(&name).as_ref() != Some(&role) {
                RoleApplied {
                    vault: vault.clone(),
                    role: name,
                }
                .publish(&env);
            }
        }
        Ok(())
    }

    fn creator_of(env: &Env, vault: &Address) -> Result<Address, Error> {
        load(env, &Key::Creator(vault.clone())).ok_or(Error::NotRegistered)
    }
}

fn current(env: &Env, vault: &Address) -> Result<PolicyV2, Error> {
    load(env, &Key::Policy(vault.clone())).ok_or(Error::NotRegistered)
}

/// Applies `policy` now when it only tightens, otherwise queues it behind the timelock.
fn change(env: &Env, vault: Address, policy: PolicyV2) -> Result<PolicyChange, Error> {
    let current = current(env, &vault)?;
    rules::validate(&policy, &current.assets.get_unchecked(0))?;
    let pending = Key::Pending(vault.clone());
    if rules::loosens(&current, &policy) {
        let eta = env
            .ledger()
            .timestamp()
            .saturating_add(PolicyRegistry::policy_timelock(env.clone()));
        store(env, &pending, &PendingPolicy { policy, eta });
        PolicyProposed { vault, eta }.publish(env);
        return Ok(PolicyChange::Proposed(eta));
    }
    env.storage().persistent().remove(&pending);
    store(env, &Key::Policy(vault.clone()), &policy);
    PolicyTightened { vault }.publish(env);
    Ok(PolicyChange::Tightened)
}

fn view<T: TryFromVal<Env, Val>>(env: &Env, vault: &Address, name: Symbol) -> T {
    env.invoke_contract(vault, &name, Vec::new(env))
}

fn load<T: TryFromVal<Env, Val>>(env: &Env, key: &Key) -> Option<T> {
    let storage = env.storage().persistent();
    let value = storage.get(key);
    if value.is_some() {
        storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    value
}

fn store<T: IntoVal<Env, Val>>(env: &Env, key: &Key, value: &T) {
    let storage = env.storage().persistent();
    storage.set(key, value);
    storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}
