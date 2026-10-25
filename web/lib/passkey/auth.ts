import { Address, Networks, authorizeEntry, hash, xdr } from "@stellar/stellar-sdk";
import { concatBytes } from "./encoding";

/** Context rule installed by the passkey account constructor. */
export const PASSKEY_RULE_ID = 0;

/** A WebAuthn assertion with the signature already in raw low-S form. */
export interface PasskeyAssertion {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

export interface PasskeySigner {
  /** Smart account (`C…`) that owns the authorization entries. */
  account: string;
  /** Deployed WebAuthn verifier contract. */
  verifier: string;
  /** 65-byte public key followed by the credential ID, as stored on-chain. */
  keyData: Uint8Array;
  /** Signs a 32-byte challenge with the passkey. */
  sign: (challenge: Uint8Array) => Promise<PasskeyAssertion>;
}

const field = (name: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
const bytes = (value: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(value));

/**
 * SHA-256 of the XDR of OZ `AuthDigestPreimage { account, signature_payload,
 * context_rule_ids }`: what external signers of an OZ smart account sign
 * instead of the raw host payload. Struct fields encode as a map sorted by name.
 */
export function authDigest(account: string, signaturePayload: Uint8Array, contextRuleIds: number[]): Uint8Array {
  const preimage = xdr.ScVal.scvMap([
    field("account", new Address(account).toScVal()),
    field("context_rule_ids", xdr.ScVal.scvVec(contextRuleIds.map(id => xdr.ScVal.scvU32(id)))),
    field("signature_payload", bytes(signaturePayload)),
  ]);
  return new Uint8Array(hash(preimage.toXDR()));
}

/**
 * Number of contexts the host passes to `__check_auth` for an entry: one per
 * node of the authorized invocation tree.
 */
export function contextCount(invocation: xdr.SorobanAuthorizedInvocation): number {
  return 1 + invocation.subInvocations.reduce((total, sub) => total + contextCount(sub), 0);
}

/** XDR of OZ `WebAuthnSigData`, the bytes the verifier contract decodes. */
export function webAuthnSigData(assertion: PasskeyAssertion): Uint8Array {
  if (assertion.signature.length !== 64) throw new Error("Expected a 64-byte raw signature");
  return new Uint8Array(xdr.ScVal.scvMap([
    field("authenticator_data", bytes(assertion.authenticatorData)),
    field("client_data", bytes(assertion.clientDataJSON)),
    field("signature", bytes(assertion.signature)),
  ]).toXDR());
}

/** OZ `AuthPayload` carrying one `Signer::External(verifier, key_data)` signature. */
export function authPayload(verifier: string, keyData: Uint8Array, sigData: Uint8Array, contextRuleIds: number[]): xdr.ScVal {
  const signer = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), new Address(verifier).toScVal(), bytes(keyData)]);
  return xdr.ScVal.scvMap([
    field("context_rule_ids", xdr.ScVal.scvVec(contextRuleIds.map(id => xdr.ScVal.scvU32(id)))),
    field("signers", xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signer, val: bytes(sigData) })])),
  ]);
}

export function keyData(publicKey: Uint8Array, credentialId: Uint8Array): Uint8Array {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error("Expected an uncompressed P-256 public key");
  return concatBytes(publicKey, credentialId);
}

/**
 * Signs a simulated authorization entry of the passkey account. The passkey
 * signs the OZ auth digest of the host payload; every context selects the
 * passkey rule.
 */
export async function signAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: PasskeySigner,
  validUntilLedger: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  const contextRuleIds = Array.from({ length: contextCount(entry.rootInvocation) }, () => PASSKEY_RULE_ID);
  return authorizeEntry(entry, async (_preimage, payload) => {
    const digest = authDigest(signer.account, payload, contextRuleIds);
    const assertion = await signer.sign(digest);
    return { signatureScVal: authPayload(signer.verifier, signer.keyData, webAuthnSigData(assertion), contextRuleIds) };
  }, validUntilLedger, Networks.TESTNET);
}
