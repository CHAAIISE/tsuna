//! Protocol upgrade watch. The vault pins the Wasm hash of every contract it calls and of every
//! allowlisted protocol. Code that changes afterwards is halted until the owner reviews it and
//! acknowledges the new hash: the allowlist approved a program, not an address.

use soroban_sdk::{contractevent, Address, BytesN, Env, Executable, Vec};

use crate::{Error, Key};

#[contractevent]
pub struct ProtocolPinned {
    #[topic]
    pub protocol: Address,
    pub hash: BytesN<32>,
}

#[contractevent]
pub struct ProtocolUpgraded {
    #[topic]
    pub protocol: Address,
    pub old: BytesN<32>,
    pub new: BytesN<32>,
}

#[contractevent]
pub struct ProtocolAcknowledged {
    #[topic]
    pub protocol: Address,
    pub hash: BytesN<32>,
}

/// Wasm hash behind `address`; `None` for accounts, Stellar asset contracts (whose code
/// never changes) and addresses with nothing deployed.
fn current(address: &Address) -> Option<BytesN<32>> {
    match address.executable() {
        Some(Executable::Wasm(hash)) => Some(hash),
        _ => None,
    }
}

pub(crate) fn pinned(env: &Env, protocol: &Address) -> Option<BytesN<32>> {
    env.storage()
        .instance()
        .get(&Key::ProtocolHash(protocol.clone()))
}

fn pin(env: &Env, protocol: &Address, hash: &BytesN<32>) {
    env.storage()
        .instance()
        .set(&Key::ProtocolHash(protocol.clone()), hash);
}

pub(crate) fn halted(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&Key::HaltedProtocols)
        .unwrap_or_else(|| Vec::new(env))
}

/// Refuses a call into code that changed since it was pinned; the first call pins it.
pub(crate) fn verify(env: &Env, target: &Address) -> Result<(), Error> {
    let Some(hash) = current(target) else {
        return Ok(());
    };
    match pinned(env, target) {
        None => {
            pin(env, target, &hash);
            ProtocolPinned {
                protocol: target.clone(),
                hash,
            }
            .publish(env);
            Ok(())
        }
        Some(old) if old == hash => Ok(()),
        Some(_) => Err(Error::ProtocolChanged),
    }
}

/// Pins unpinned `protocols` and halts the changed ones, returned. A newly halted protocol
/// pauses a running vault; a pause already in force keeps its own origin.
pub(crate) fn check(env: &Env, protocols: &Vec<Address>) -> Vec<Address> {
    let storage = env.storage().instance();
    let mut halted = halted(env);
    let mut changed = Vec::new(env);
    let mut newly_halted = false;
    for protocol in protocols.iter() {
        let Some(hash) = current(&protocol) else {
            continue;
        };
        match pinned(env, &protocol) {
            None => {
                pin(env, &protocol, &hash);
                ProtocolPinned {
                    protocol: protocol.clone(),
                    hash,
                }
                .publish(env);
            }
            Some(old) if old != hash => {
                if !halted.contains(&protocol) {
                    halted.push_back(protocol.clone());
                    newly_halted = true;
                    ProtocolUpgraded {
                        protocol: protocol.clone(),
                        old,
                        new: hash,
                    }
                    .publish(env);
                }
                changed.push_back(protocol);
            }
            Some(_) => {}
        }
    }
    if newly_halted {
        storage.set(&Key::HaltedProtocols, &halted);
        if !storage.get(&Key::Paused).unwrap_or(false) {
            storage.set(&Key::Paused, &true);
            storage.set(&Key::WatchPaused, &true);
        }
    }
    changed
}

/// Trusts `protocol`'s current code, which must be `hash`. Clearing the last halted protocol
/// lifts the pause only if the watch itself set it.
pub(crate) fn acknowledge(env: &Env, protocol: &Address, hash: BytesN<32>) -> Result<(), Error> {
    if current(protocol).as_ref() != Some(&hash) {
        return Err(Error::ProtocolChanged);
    }
    pin(env, protocol, &hash);
    let storage = env.storage().instance();
    let mut halted = halted(env);
    if let Some(index) = halted.first_index_of(protocol) {
        halted.remove(index);
        storage.set(&Key::HaltedProtocols, &halted);
    }
    ProtocolAcknowledged {
        protocol: protocol.clone(),
        hash,
    }
    .publish(env);
    if halted.is_empty() && storage.get(&Key::WatchPaused).unwrap_or(false) {
        storage.set(&Key::Paused, &false);
        forget_watch_pause(env);
    }
    Ok(())
}

/// Called whenever the owner or the drawdown guard takes over the pause, so acknowledging
/// protocols can no longer lift it.
pub(crate) fn forget_watch_pause(env: &Env) {
    env.storage().instance().remove(&Key::WatchPaused);
}
