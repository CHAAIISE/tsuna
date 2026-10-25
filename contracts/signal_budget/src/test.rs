extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use signal_budget_ed25519_verifier::Ed25519VerifierContract;
use signal_budget_spending_limit_policy::{SpendingLimitError, SpendingLimitPolicyContract};
use soroban_sdk::{
    auth::{Context, ContractContext},
    map, symbol_short,
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{
        Hash as XdrHash, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs,
        Limits, ScErrorCode, ScErrorType, ScVal, SorobanAddressCredentials,
        SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
        SorobanCredentials, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, TryFromVal, Val,
};
use stellar_accounts::smart_account::{AuthDigestPreimage, AuthPayload, Signer, SmartAccountError};

use crate::{SignalBudget, SignalBudgetClient, ADMIN_RULE_ID, SESSION_RULE_ID};

const LIMIT: i128 = 50_000_000;
const PERIOD: u32 = 17_280;
const THREE_USDC: i128 = 30_000_000;
const FUNDING: i128 = 100_000_000;
const SESSION_SECRET: [u8; 32] = [7; 32];
const ATTACKER_SECRET: [u8; 32] = [9; 32];

struct Setup {
    e: Env,
    account: Address,
    usdc: Address,
    recipient: Address,
    verifier: Address,
    session: SigningKey,
    nonce: i64,
}

impl Setup {
    fn new() -> Self {
        let e = Env::default();
        // The rolling window treats entries at or below `sequence - period`
        // as expired, which includes ledger 0; start from a live-like ledger.
        e.ledger().set_sequence_number(1_000_000);
        e.ledger().set_min_persistent_entry_ttl(100_000);
        e.ledger().set_min_temp_entry_ttl(100_000);
        e.ledger().set_max_entry_ttl(1_000_000);

        let usdc_admin = Address::generate(&e);
        let usdc = e
            .register_stellar_asset_contract_v2(usdc_admin.clone())
            .address();
        let verifier = e.register(Ed25519VerifierContract, ());
        let policy = e.register(SpendingLimitPolicyContract, ());
        let session = SigningKey::from_bytes(&SESSION_SECRET);

        let account = e.register(
            SignalBudget,
            (
                Address::generate(&e),
                BytesN::from_array(&e, session.verifying_key().as_bytes()),
                usdc.clone(),
                LIMIT,
                PERIOD,
                verifier.clone(),
                policy,
            ),
        );

        let mint_args = (account.clone(), FUNDING);
        StellarAssetClient::new(&e, &usdc)
            .mock_auths(&[MockAuth {
                address: &usdc_admin,
                invoke: &MockAuthInvoke {
                    contract: &usdc,
                    fn_name: "mint",
                    args: mint_args.clone().into_val(&e),
                    sub_invokes: &[],
                },
            }])
            .mint(&mint_args.0, &mint_args.1);

        let recipient = Address::generate(&e);
        Setup {
            e,
            account,
            usdc,
            recipient,
            verifier,
            session,
            nonce: 0,
        }
    }

    fn session_signer(&self) -> Signer {
        self.signer_for(&self.session)
    }

    fn signer_for(&self, key: &SigningKey) -> Signer {
        Signer::External(
            self.verifier.clone(),
            Bytes::from_array(&self.e, key.verifying_key().as_bytes()),
        )
    }

    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.e, &self.usdc)
    }

    /// Transfers USDC out of the account with a real, signed authorization
    /// entry: `key` signs the OZ auth digest and is presented as `signer`.
    fn transfer(
        &mut self,
        key: &SigningKey,
        signer: Signer,
        amount: i128,
    ) -> Result<(), soroban_sdk::Error> {
        let e = &self.e;
        self.nonce += 1;
        let expiration = e.ledger().sequence() + 100;
        let invocation = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                contract_address: (&self.usdc).into(),
                function_name: "transfer".try_into().unwrap(),
                args: std::vec![
                    to_scval(e, self.account.clone()),
                    to_scval(e, self.recipient.clone()),
                    to_scval(e, amount),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: VecM::default(),
        };
        let preimage = HashIdPreimage::SorobanAuthorization(HashIdPreimageSorobanAuthorization {
            network_id: XdrHash(e.ledger().get().network_id),
            nonce: self.nonce,
            signature_expiration_ledger: expiration,
            invocation: invocation.clone(),
        });
        let xdr = preimage.to_xdr(Limits::none()).unwrap();
        let signature_payload = e.crypto().sha256(&Bytes::from_slice(e, &xdr)).to_bytes();

        let payload = signed_payload(e, &self.account, key, signer, signature_payload);
        e.set_auths(&[SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: (&self.account).into(),
                nonce: self.nonce,
                signature_expiration_ledger: expiration,
                signature: to_scval(e, payload),
            }),
            root_invocation: invocation,
        }]);

        match self
            .token()
            .try_transfer(&self.account, &self.recipient, &amount)
        {
            Ok(_) => Ok(()),
            Err(Ok(err)) => Err(err),
            Err(Err(invoke)) => panic!("unexpected invoke error: {invoke:?}"),
        }
    }

    /// Runs the account's `__check_auth` directly for a USDC transfer so the
    /// contract error behind a refusal is observable; the host reports it as
    /// a generic auth failure on the real `transfer` path.
    fn check_transfer_auth<E>(
        &self,
        key: &SigningKey,
        signer: Signer,
        amount: i128,
    ) -> Result<(), Result<E, InvokeError>>
    where
        E: TryFrom<soroban_sdk::Error>,
        E::Error: Into<InvokeError>,
    {
        let e = &self.e;
        let signature_payload = BytesN::from_array(e, &[42; 32]);
        let payload = signed_payload(e, &self.account, key, signer, signature_payload.clone());
        let context = Context::Contract(ContractContext {
            contract: self.usdc.clone(),
            fn_name: symbol_short!("transfer"),
            args: (self.account.clone(), self.recipient.clone(), amount).into_val(e),
        });
        e.try_invoke_contract_check_auth::<E>(
            &self.account,
            &signature_payload,
            payload.into_val(e),
            &vec![e, context],
        )
    }
}

fn signed_payload(
    e: &Env,
    account: &Address,
    key: &SigningKey,
    signer: Signer,
    signature_payload: BytesN<32>,
) -> AuthPayload {
    let context_rule_ids = vec![e, SESSION_RULE_ID];
    let digest = AuthDigestPreimage {
        account: account.clone(),
        signature_payload,
        context_rule_ids: context_rule_ids.clone(),
    }
    .digest(e);
    let signature = key.sign(&digest.to_array()).to_bytes();
    AuthPayload {
        signers: map![e, (signer, Bytes::from_array(e, &signature))],
        context_rule_ids,
    }
}

fn to_scval<T: IntoVal<Env, Val>>(e: &Env, value: T) -> ScVal {
    ScVal::try_from_val(e, &value.into_val(e)).unwrap()
}

#[test]
fn constructor_installs_admin_and_session_rules() {
    let s = Setup::new();
    let client = SignalBudgetClient::new(&s.e, &s.account);

    assert_eq!(client.get_context_rules_count(), 2);
    let session_rule = client.get_context_rule(&SESSION_RULE_ID);
    assert_eq!(session_rule.signers, vec![&s.e, s.session_signer()]);
    assert_eq!(session_rule.policies.len(), 1);
    assert_eq!(client.get_context_rule(&ADMIN_RULE_ID).policies.len(), 0);
}

#[test]
fn session_key_transfer_within_limit_succeeds() {
    let mut s = Setup::new();
    let session = s.session.clone();
    let signer = s.session_signer();

    s.transfer(&session, signer, THREE_USDC).unwrap();

    assert_eq!(s.token().balance(&s.recipient), THREE_USDC);
    assert_eq!(s.token().balance(&s.account), FUNDING - THREE_USDC);
}

#[test]
fn spending_limit_exceeded_refuses_second_transfer_in_period() {
    let mut s = Setup::new();
    let session = s.session.clone();
    let signer = s.session_signer();
    s.transfer(&session, signer.clone(), THREE_USDC).unwrap();

    assert_eq!(
        s.check_transfer_auth::<SpendingLimitError>(&session, signer.clone(), THREE_USDC),
        Err(Ok(SpendingLimitError::SpendingLimitExceeded))
    );
    assert_eq!(
        s.transfer(&session, signer, THREE_USDC),
        Err(auth_failure())
    );

    assert_eq!(s.token().balance(&s.recipient), THREE_USDC);
    assert_eq!(s.token().balance(&s.account), FUNDING - THREE_USDC);
}

#[test]
fn spending_limit_resets_after_period() {
    let mut s = Setup::new();
    let session = s.session.clone();
    let signer = s.session_signer();
    s.transfer(&session, signer.clone(), THREE_USDC).unwrap();

    s.e.ledger().with_mut(|li| li.sequence_number += PERIOD - 1);
    assert_eq!(
        s.check_transfer_auth::<SpendingLimitError>(&session, signer.clone(), THREE_USDC),
        Err(Ok(SpendingLimitError::SpendingLimitExceeded))
    );

    s.e.ledger().with_mut(|li| li.sequence_number += 1);
    s.transfer(&session, signer, THREE_USDC).unwrap();

    assert_eq!(s.token().balance(&s.recipient), 2 * THREE_USDC);
}

#[test]
fn non_session_key_signature_is_rejected() {
    let mut s = Setup::new();
    let attacker = SigningKey::from_bytes(&ATTACKER_SECRET);
    let session_signer = s.session_signer();
    let attacker_signer = s.signer_for(&attacker);

    // Attacker signature presented under the session key identity: the
    // verifier's host-level ed25519 check traps instead of returning false.
    assert_eq!(
        s.check_transfer_auth::<soroban_sdk::Error>(&attacker, session_signer.clone(), THREE_USDC),
        Err(Ok(soroban_sdk::Error::from_type_and_code(
            ScErrorType::Crypto,
            ScErrorCode::InvalidInput
        )))
    );
    assert_eq!(
        s.transfer(&attacker, session_signer, THREE_USDC),
        Err(auth_failure())
    );

    // Attacker key presented as a signer of its own.
    assert_eq!(
        s.check_transfer_auth::<SmartAccountError>(&attacker, attacker_signer.clone(), THREE_USDC),
        Err(Ok(SmartAccountError::UnauthorizedSigner))
    );
    assert_eq!(
        s.transfer(&attacker, attacker_signer, THREE_USDC),
        Err(auth_failure())
    );

    assert_eq!(s.token().balance(&s.recipient), 0);
    assert_eq!(s.token().balance(&s.account), FUNDING);
}

/// Error the host returns to the caller when `__check_auth` fails.
fn auth_failure() -> soroban_sdk::Error {
    soroban_sdk::Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}
