#![no_std]
//! Deploys agent vaults whose executable is an external ref owned by this
//! factory, so one timelocked 2-of-2 ref swap upgrades the whole fleet.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN,
    ContractExecutable, ContractExecutableRef, Env, String, Vec,
};

pub const VAULT_TAG: &str = "vault-v1";

const DAY_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const TTL_EXTEND_TO: u32 = 120 * DAY_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    RefAlreadySet = 1,
    RefNotSet = 2,
    TimelockActive = 3,
    NoPendingRef = 4,
    SameRef = 5,
    DistinctAdminsRequired = 6,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultParams {
    pub asset: Address,
    pub protocol_recipient: Address,
    pub oracle: Address,
    pub registry: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRef {
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    AdminA,
    AdminB,
    Timelock,
    VaultCount,
    Vault(u32),
    Pending(String),
}

#[contractevent]
pub struct RefSet {
    #[topic]
    pub tag: String,
    pub wasm_hash: BytesN<32>,
}

#[contractevent]
pub struct RefProposed {
    #[topic]
    pub tag: String,
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[contractevent]
pub struct FleetUpgraded {
    #[topic]
    pub tag: String,
    pub old: BytesN<32>,
    pub new: BytesN<32>,
}

#[contractevent]
pub struct VaultDeployed {
    #[topic]
    pub creator: Address,
    #[topic]
    pub vault: Address,
    pub agent: Address,
    pub index: u32,
}

#[contract]
pub struct VaultFactory;

fn require_admins(env: &Env) {
    let s = env.storage().instance();
    let a: Address = s.get(&Key::AdminA).unwrap();
    let b: Address = s.get(&Key::AdminB).unwrap();
    a.require_auth();
    b.require_auth();
    s.extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn bump_ref(env: &Env, tag: &String) {
    env.executable_refs()
        .extend_ttl(tag, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn salt_for(env: &Env, index: u32) -> BytesN<32> {
    let mut raw = [0u8; 32];
    raw[28..].copy_from_slice(&index.to_be_bytes());
    BytesN::from_array(env, &raw)
}

#[contractimpl]
impl VaultFactory {
    pub fn __constructor(
        env: Env,
        admin_a: Address,
        admin_b: Address,
        timelock_secs: u64,
    ) -> Result<(), Error> {
        if admin_a == admin_b {
            return Err(Error::DistinctAdminsRequired);
        }
        let s = env.storage().instance();
        s.set(&Key::AdminA, &admin_a);
        s.set(&Key::AdminB, &admin_b);
        s.set(&Key::Timelock, &timelock_secs);
        s.set(&Key::VaultCount, &0u32);
        Ok(())
    }

    /// Initial publication only; existing refs move through the timelock.
    pub fn set_ref(env: Env, tag: String, wasm_hash: BytesN<32>) -> Result<(), Error> {
        require_admins(&env);
        let refs = env.executable_refs();
        if refs.has(&tag) {
            return Err(Error::RefAlreadySet);
        }
        refs.set(&tag, &wasm_hash);
        bump_ref(&env, &tag);
        RefSet { tag, wasm_hash }.publish(&env);
        Ok(())
    }

    pub fn propose_ref(env: Env, tag: String, wasm_hash: BytesN<32>) -> Result<u64, Error> {
        require_admins(&env);
        let current = env.executable_refs().get(&tag).ok_or(Error::RefNotSet)?;
        if current == wasm_hash {
            return Err(Error::SameRef);
        }
        let delay: u64 = env.storage().instance().get(&Key::Timelock).unwrap();
        let eta = env.ledger().timestamp().saturating_add(delay);
        let key = Key::Pending(tag.clone());
        let p = env.storage().persistent();
        p.set(
            &key,
            &PendingRef {
                wasm_hash: wasm_hash.clone(),
                eta,
            },
        );
        p.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        RefProposed {
            tag,
            wasm_hash,
            eta,
        }
        .publish(&env);
        Ok(eta)
    }

    pub fn apply_ref(env: Env, tag: String) -> Result<(), Error> {
        require_admins(&env);
        let key = Key::Pending(tag.clone());
        let p = env.storage().persistent();
        let pending: PendingRef = p.get(&key).ok_or(Error::NoPendingRef)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockActive);
        }
        let refs = env.executable_refs();
        let old = refs.get(&tag).ok_or(Error::RefNotSet)?;
        refs.set(&tag, &pending.wasm_hash);
        bump_ref(&env, &tag);
        p.remove(&key);
        FleetUpgraded {
            tag,
            old,
            new: pending.wasm_hash,
        }
        .publish(&env);
        Ok(())
    }

    pub fn cancel_ref(env: Env, tag: String) -> Result<(), Error> {
        require_admins(&env);
        let key = Key::Pending(tag);
        let p = env.storage().persistent();
        if !p.has(&key) {
            return Err(Error::NoPendingRef);
        }
        p.remove(&key);
        Ok(())
    }

    pub fn deploy_vault(
        env: Env,
        creator: Address,
        agent: Address,
        params: VaultParams,
    ) -> Result<Address, Error> {
        creator.require_auth();
        let tag = String::from_str(&env, VAULT_TAG);
        if !env.executable_refs().has(&tag) {
            return Err(Error::RefNotSet);
        }
        let s = env.storage().instance();
        let index: u32 = s.get(&Key::VaultCount).unwrap();
        let factory = env.current_contract_address();
        let vault = env
            .deployer()
            .with_current_contract(salt_for(&env, index))
            .deploy_contract(
                ContractExecutable::ExternalRef(ContractExecutableRef {
                    owner: factory,
                    tag: tag.clone(),
                }),
                (
                    creator.clone(),
                    agent.clone(),
                    params.asset,
                    params.protocol_recipient,
                    params.oracle,
                    params.registry,
                ),
            );
        let p = env.storage().persistent();
        p.set(&Key::Vault(index), &vault);
        p.extend_ttl(&Key::Vault(index), TTL_THRESHOLD, TTL_EXTEND_TO);
        s.set(&Key::VaultCount, &(index + 1));
        s.extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        bump_ref(&env, &tag);
        VaultDeployed {
            creator,
            vault: vault.clone(),
            agent,
            index,
        }
        .publish(&env);
        Ok(vault)
    }

    pub fn vault_count(env: Env) -> u32 {
        env.storage().instance().get(&Key::VaultCount).unwrap_or(0)
    }

    pub fn vaults(env: Env) -> Vec<Address> {
        let n = Self::vault_count(env.clone());
        let p = env.storage().persistent();
        let mut out = Vec::new(&env);
        for i in 0..n {
            out.push_back(p.get(&Key::Vault(i)).unwrap());
        }
        out
    }

    pub fn current_ref(env: Env, tag: String) -> Option<BytesN<32>> {
        env.executable_refs().get(&tag)
    }

    pub fn pending_ref(env: Env, tag: String) -> Option<PendingRef> {
        env.storage().persistent().get(&Key::Pending(tag))
    }

    pub fn admins(env: Env) -> (Address, Address) {
        let s = env.storage().instance();
        (s.get(&Key::AdminA).unwrap(), s.get(&Key::AdminB).unwrap())
    }

    pub fn timelock(env: Env) -> u64 {
        env.storage().instance().get(&Key::Timelock).unwrap()
    }
}

#[cfg(test)]
mod test;
