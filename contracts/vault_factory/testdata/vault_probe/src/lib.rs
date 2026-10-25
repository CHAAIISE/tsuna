#![no_std]
//! Minimal replacement executable used to prove that a fleet-wide ref swap
//! reaches every vault deployed from the factory.
use soroban_sdk::{contract, contractimpl};

#[contract]
pub struct VaultProbe;

#[contractimpl]
impl VaultProbe {
    pub fn version() -> u32 {
        2
    }
}
