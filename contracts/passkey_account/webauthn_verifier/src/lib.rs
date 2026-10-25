#![no_std]
//! Stateless WebAuthn (secp256r1) verifier backing the passkey signer of every
//! Leash passkey account. One deployment serves every account.
//!
//! `key_data` is the 65-byte uncompressed public key, optionally followed by
//! the credential ID so clients can find the passkey again. `sig_data` is the
//! XDR encoding of `WebAuthnSigData`: the smart account forwards signatures as
//! opaque bytes, so a struct cannot be passed directly.
use soroban_sdk::{contract, contractimpl, xdr::FromXdr, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::{
    utils::extract_from_bytes,
    webauthn::{self, WebAuthnError, WebAuthnSigData},
    Verifier,
};

#[contract]
pub struct WebAuthnVerifierContract;

#[contractimpl]
impl Verifier for WebAuthnVerifierContract {
    type KeyData = Bytes;
    type SigData = Bytes;

    fn verify(e: &Env, signature_payload: Bytes, key_data: Bytes, sig_data: Bytes) -> bool {
        let sig_data = WebAuthnSigData::from_xdr(e, &sig_data).unwrap_or_else(|_| {
            soroban_sdk::panic_with_error!(e, WebAuthnError::SignaturePayloadInvalid)
        });
        let pub_key: BytesN<65> = extract_from_bytes(e, &key_data, 0..65)
            .unwrap_or_else(|| soroban_sdk::panic_with_error!(e, WebAuthnError::KeyDataInvalid));
        webauthn::verify(e, &signature_payload, &pub_key, &sig_data)
    }

    fn canonicalize_key(e: &Env, key_data: Bytes) -> Bytes {
        webauthn::canonicalize_key(e, &key_data)
    }

    fn batch_canonicalize_key(e: &Env, keys_data: Vec<Bytes>) -> Vec<Bytes> {
        webauthn::batch_canonicalize_key(e, &keys_data)
    }
}
