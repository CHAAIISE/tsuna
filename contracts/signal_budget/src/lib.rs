#![no_std]
//! Smart account paying for agent API calls (x402 / MPP). The admin keeps full
//! control through a default rule; the agent session key can only call the
//! USDC contract, and every `transfer` it signs is metered by the spending
//! limit policy over a rolling window of ledgers.
#[cfg(test)]
mod test;

// The `contracttrait` default methods expand to code naming these types, so
// they must be in scope even where this file does not use them directly.
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    vec, Address, Bytes, BytesN, Env, IntoVal, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::{
    policies::spending_limit::SpendingLimitAccountParams,
    smart_account::{
        self, AuthDigestPreimage, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint,
        Signer, SmartAccount, SmartAccountError,
    },
};

/// Rule of the admin signer, valid for any context.
pub const ADMIN_RULE_ID: u32 = 0;
/// Rule of the session key, restricted to the USDC contract and the spending
/// limit policy. Session signatures must select it in `context_rule_ids`.
pub const SESSION_RULE_ID: u32 = 1;

#[contract]
pub struct SignalBudget;

#[contractimpl]
impl SignalBudget {
    /// `verifier` is a deployed Ed25519 verifier and `policy` a deployed
    /// spending limit policy; both are shared across accounts.
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: &Env,
        admin: Address,
        session_key: BytesN<32>,
        usdc: Address,
        spending_limit: i128,
        period_ledgers: u32,
        verifier: Address,
        policy: Address,
    ) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &String::from_str(e, "admin"),
            None,
            &vec![e, Signer::Delegated(admin)],
            &Map::new(e),
        );

        let mut policies = Map::new(e);
        policies.set(
            policy,
            SpendingLimitAccountParams {
                spending_limit,
                period_ledgers,
            }
            .into_val(e),
        );
        smart_account::add_context_rule(
            e,
            &ContextRuleType::CallContract(usdc),
            &String::from_str(e, "session"),
            None,
            &vec![e, Signer::External(verifier, Bytes::from(session_key))],
            &policies,
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for SignalBudget {
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
impl SmartAccount for SignalBudget {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for SignalBudget {}
