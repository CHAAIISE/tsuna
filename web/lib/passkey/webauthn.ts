import type { PasskeyAssertion } from "./auth";
import { derToLowSRawSignature, p256PublicKeyFromSpki } from "./encoding";

/** COSE identifier of ES256 (ECDSA with P-256 and SHA-256). */
const ES256 = -7;
const TIMEOUT_MS = 120_000;

export interface CreatedPasskey {
  credentialId: Uint8Array;
  /** 65-byte uncompressed P-256 public key. */
  publicKey: Uint8Array;
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Creates a P-256 passkey that requires user verification on this device. */
export async function createPasskey(): Promise<CreatedPasskey> {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: "Tsuna" },
      user: { id: randomBytes(16), name: `Tsuna account ${new Date().toISOString().slice(0, 10)}`, displayName: "Tsuna account" },
      // Registration is not verified on-chain: the account stores the public key.
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: "public-key", alg: ES256 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      attestation: "none",
      timeout: TIMEOUT_MS,
    },
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("No passkey was created.");
  }
  const response = credential.response;
  const spki = response.getPublicKey();
  if (response.getPublicKeyAlgorithm() !== ES256 || !spki) {
    throw new Error("This authenticator does not support P-256 passkeys.");
  }
  return { credentialId: new Uint8Array(credential.rawId), publicKey: p256PublicKeyFromSpki(new Uint8Array(spki)) };
}

/** Signs `challenge` with the passkey and returns the assertion in on-chain form. */
export async function signWithPasskey(credentialId: Uint8Array, challenge: Uint8Array): Promise<PasskeyAssertion> {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: new Uint8Array(challenge),
      allowCredentials: [{ type: "public-key", id: new Uint8Array(credentialId) }],
      userVerification: "required",
      timeout: TIMEOUT_MS,
    },
  });
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("The passkey did not sign.");
  }
  const response = credential.response;
  return {
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
    signature: derToLowSRawSignature(new Uint8Array(response.signature)),
  };
}
