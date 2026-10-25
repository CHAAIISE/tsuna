#![no_std]
//! Passkey smart account for Leash depositors. A single default context rule
//! holds the user's WebAuthn (secp256r1) passkey, verified by a shared
//! verifier contract, so the passkey alone authorizes any call made from the
//! account. Fees are paid by a relayer: the account never needs XLM.
#[cfg(test)]
mod test;

// The `contracttrait` default methods expand to code naming these types, so
// they must be in scope even where this file does not use them directly.
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    vec, Address, Bytes, BytesN, Env, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{
    self, AuthDigestPreimage, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint,
    Signer, SmartAccount, SmartAccountError,
};

/// Rule of the passkey signer, valid for any context. Signatures must select
/// it once per authorized context in `context_rule_ids`.
pub const PASSKEY_RULE_ID: u32 = 0;

#[contract]
pub struct PasskeyAccount;

#[contractimpl]
impl PasskeyAccount {
    /// `verifier` is the deployed WebAuthn verifier; `key_data` is the 65-byte
    /// uncompressed P-256 public key followed by the credential ID.
    pub fn __constructor(e: &Env, verifier: Address, key_data: Bytes) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &String::from_str(e, "passkey"),
            None,
            &vec![e, Signer::External(verifier, key_data)],
            &Map::new(e),
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for PasskeyAccount {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

#[contractimpl(contracttrait)]
impl SmartAccount for PasskeyAccount {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for PasskeyAccount {}
