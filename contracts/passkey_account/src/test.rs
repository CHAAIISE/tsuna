extern crate std;

use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
use passkey_webauthn_verifier::WebAuthnVerifierContract;
use soroban_sdk::{
    auth::{Context, ContractContext},
    map, symbol_short,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::{
        Hash as XdrHash, HashIdPreimage, HashIdPreimageSorobanAuthorization, InvokeContractArgs,
        Limits, ScErrorCode, ScErrorType, ScVal, SorobanAddressCredentials,
        SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
        SorobanCredentials, ToXdr, VecM, WriteXdr,
    },
    Address, Bytes, BytesN, Env, IntoVal, InvokeError, TryFromVal, Val,
};
use stellar_accounts::{
    smart_account::{AuthDigestPreimage, AuthPayload, Signer},
    verifiers::{
        utils::base64_url_encode,
        webauthn::{WebAuthnError, WebAuthnSigData, AUTH_DATA_FLAGS_UP, AUTH_DATA_FLAGS_UV},
    },
};

use crate::{PasskeyAccount, PasskeyAccountClient, PASSKEY_RULE_ID};

/// 1,000 and 250 USDC in seven-decimal units.
const FUNDING: i128 = 10_000_000_000;
const AMOUNT: i128 = 2_500_000_000;
const PASSKEY_SECRET: [u8; 32] = [21; 32];
const OTHER_SECRET: [u8; 32] = [42; 32];
const CREDENTIAL_ID: [u8; 16] = [7; 16];
const RP_ID_HASH: [u8; 32] = [3; 32];

/// What a passkey assertion looks like, with knobs to tamper with each part.
struct Assertion {
    flags: u8,
    /// Challenge written into `clientDataJSON`; the digest when `None`.
    challenge: Option<[u8; 32]>,
    high_s: bool,
}

impl Default for Assertion {
    fn default() -> Self {
        Assertion {
            flags: AUTH_DATA_FLAGS_UP | AUTH_DATA_FLAGS_UV,
            challenge: None,
            high_s: false,
        }
    }
}

struct Setup {
    e: Env,
    account: Address,
    usdc: Address,
    recipient: Address,
    verifier: Address,
    passkey: SigningKey,
    nonce: i64,
}

impl Setup {
    fn new() -> Self {
        let e = Env::default();
        let usdc_admin = Address::generate(&e);
        let usdc = e
            .register_stellar_asset_contract_v2(usdc_admin.clone())
            .address();
        let verifier = e.register(WebAuthnVerifierContract, ());
        let passkey = SigningKey::from_slice(&PASSKEY_SECRET).unwrap();
        let account = e.register(PasskeyAccount, (verifier.clone(), key_data(&e, &passkey)));

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

        Setup {
            recipient: Address::generate(&e),
            e,
            account,
            usdc,
            verifier,
            passkey,
            nonce: 0,
        }
    }

    fn passkey_signer(&self) -> Signer {
        Signer::External(self.verifier.clone(), key_data(&self.e, &self.passkey))
    }

    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.e, &self.usdc)
    }

    /// Transfers USDC out of the account through the real authorization path:
    /// the host computes the payload and calls `__check_auth`.
    fn transfer(
        &mut self,
        key: &SigningKey,
        assertion: &Assertion,
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
                    to_scval(e, AMOUNT),
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

        let payload = self.signed_payload(key, assertion, signature_payload);
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
            .try_transfer(&self.account, &self.recipient, &AMOUNT)
        {
            Ok(_) => Ok(()),
            Err(Ok(err)) => Err(err),
            Err(Err(invoke)) => panic!("unexpected invoke error: {invoke:?}"),
        }
    }

    /// Runs `__check_auth` directly so the error behind a refusal is
    /// observable; the real path reports any failure as a generic auth error.
    fn check_auth<E>(
        &self,
        key: &SigningKey,
        assertion: &Assertion,
    ) -> Result<(), Result<E, InvokeError>>
    where
        E: TryFrom<soroban_sdk::Error>,
        E::Error: Into<InvokeError>,
    {
        let e = &self.e;
        let signature_payload = BytesN::from_array(e, &[9; 32]);
        let payload = self.signed_payload(key, assertion, signature_payload.clone());
        let context = Context::Contract(ContractContext {
            contract: self.usdc.clone(),
            fn_name: symbol_short!("transfer"),
            args: (self.account.clone(), self.recipient.clone(), AMOUNT).into_val(e),
        });
        e.try_invoke_contract_check_auth::<E>(
            &self.account,
            &signature_payload,
            payload.into_val(e),
            &vec![e, context],
        )
    }

    /// Builds the `AuthPayload` a browser produces: the passkey signs the OZ
    /// auth digest as a WebAuthn challenge, and the account's signer entry
    /// carries the XDR-encoded assertion.
    fn signed_payload(
        &self,
        key: &SigningKey,
        assertion: &Assertion,
        signature_payload: BytesN<32>,
    ) -> AuthPayload {
        let e = &self.e;
        let context_rule_ids = vec![e, PASSKEY_RULE_ID];
        let digest = AuthDigestPreimage {
            account: self.account.clone(),
            signature_payload,
            context_rule_ids: context_rule_ids.clone(),
        }
        .digest(e)
        .to_array();

        let mut challenge = [0u8; 43];
        base64_url_encode(&mut challenge, &assertion.challenge.unwrap_or(digest));
        let client_data = std::format!(
            r#"{{"type":"webauthn.get","challenge":"{}","origin":"http://localhost:3000","crossOrigin":false}}"#,
            std::str::from_utf8(&challenge).unwrap()
        );
        let client_data = Bytes::from_slice(e, client_data.as_bytes());

        let mut authenticator_data = [0u8; 37];
        authenticator_data[..32].copy_from_slice(&RP_ID_HASH);
        authenticator_data[32] = assertion.flags;
        authenticator_data[36] = 1;
        let authenticator_data = Bytes::from_array(e, &authenticator_data);

        let mut message = authenticator_data.clone();
        message.extend_from_array(&e.crypto().sha256(&client_data).to_array());
        let message_hash = e.crypto().sha256(&message).to_array();
        let signature: Signature = key.sign_prehash(&message_hash).unwrap();
        let low = signature.normalize_s().unwrap_or(signature);
        let signature = if assertion.high_s {
            let (r, s) = low.split_scalars();
            Signature::from_scalars(r, -*s).unwrap()
        } else {
            low
        };
        let mut raw = [0u8; 64];
        raw.copy_from_slice(&signature.to_bytes());

        let sig_data = WebAuthnSigData {
            signature: BytesN::from_array(e, &raw),
            authenticator_data,
            client_data,
        };
        AuthPayload {
            signers: map![e, (self.passkey_signer(), sig_data.to_xdr(e))],
            context_rule_ids,
        }
    }
}

fn key_data(e: &Env, key: &SigningKey) -> Bytes {
    let point = key.verifying_key().to_encoded_point(false);
    let mut data = Bytes::from_slice(e, point.as_bytes());
    data.extend_from_array(&CREDENTIAL_ID);
    data
}

fn to_scval<T: IntoVal<Env, Val>>(e: &Env, value: T) -> ScVal {
    ScVal::try_from_val(e, &value.into_val(e)).unwrap()
}

/// Error the host returns to the caller when `__check_auth` fails.
fn auth_failure() -> soroban_sdk::Error {
    soroban_sdk::Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

fn crypto_failure() -> soroban_sdk::Error {
    soroban_sdk::Error::from_type_and_code(ScErrorType::Crypto, ScErrorCode::InvalidInput)
}

fn webauthn_failure(error: WebAuthnError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(error as u32)
}

#[test]
fn constructor_installs_the_passkey_rule() {
    let s = Setup::new();
    let client = PasskeyAccountClient::new(&s.e, &s.account);

    assert_eq!(client.get_context_rules_count(), 1);
    let rule = client.get_context_rule(&PASSKEY_RULE_ID);
    assert_eq!(rule.signers, vec![&s.e, s.passkey_signer()]);
    assert_eq!(rule.policies.len(), 0);
}

#[test]
fn passkey_signed_transfer_succeeds() {
    let mut s = Setup::new();
    let passkey = s.passkey.clone();

    s.transfer(&passkey, &Assertion::default()).unwrap();

    assert_eq!(s.token().balance(&s.recipient), AMOUNT);
    assert_eq!(s.token().balance(&s.account), FUNDING - AMOUNT);
}

#[test]
fn signature_from_another_key_is_rejected() {
    let mut s = Setup::new();
    let other = SigningKey::from_slice(&OTHER_SECRET).unwrap();

    assert_eq!(
        s.check_auth::<soroban_sdk::Error>(&other, &Assertion::default()),
        Err(Ok(crypto_failure()))
    );
    assert_eq!(
        s.transfer(&other, &Assertion::default()),
        Err(auth_failure())
    );
    assert_eq!(s.token().balance(&s.account), FUNDING);
}

#[test]
fn assertion_for_another_payload_is_rejected() {
    let mut s = Setup::new();
    let passkey = s.passkey.clone();
    let replayed = Assertion {
        challenge: Some([1; 32]),
        ..Assertion::default()
    };

    assert_eq!(
        s.check_auth::<soroban_sdk::Error>(&passkey, &replayed),
        Err(Ok(webauthn_failure(WebAuthnError::ChallengeInvalid)))
    );
    assert_eq!(s.transfer(&passkey, &replayed), Err(auth_failure()));
    assert_eq!(s.token().balance(&s.account), FUNDING);
}

#[test]
fn assertion_without_user_verification_is_rejected() {
    let mut s = Setup::new();
    let passkey = s.passkey.clone();
    let unverified = Assertion {
        flags: AUTH_DATA_FLAGS_UP,
        ..Assertion::default()
    };

    assert_eq!(
        s.check_auth::<soroban_sdk::Error>(&passkey, &unverified),
        Err(Ok(webauthn_failure(WebAuthnError::VerifiedBitNotSet)))
    );
    assert_eq!(s.transfer(&passkey, &unverified), Err(auth_failure()));
}

#[test]
fn high_s_signature_is_rejected() {
    let s = Setup::new();
    let passkey = s.passkey.clone();
    let malleated = Assertion {
        high_s: true,
        ..Assertion::default()
    };

    assert_eq!(
        s.check_auth::<soroban_sdk::Error>(&passkey, &malleated),
        Err(Ok(crypto_failure()))
    );
    assert_eq!(
        s.check_auth::<soroban_sdk::Error>(&passkey, &Assertion::default()),
        Ok(())
    );
}

#[test]
#[should_panic]
fn constructor_rejects_a_truncated_public_key() {
    let e = Env::default();
    let verifier = e.register(WebAuthnVerifierContract, ());
    e.register(
        PasskeyAccount,
        (verifier, Bytes::from_array(&e, &[4u8; 64])),
    );
}
