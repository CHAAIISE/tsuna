/** Order of the P-256 group. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** DER prefix of a P-256 SubjectPublicKeyInfo; the 65-byte point follows it. */
const P256_SPKI_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d030107034200";

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`);
}

function bigIntTo32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("Scalar does not fit in 32 bytes");
  return Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16));
}

/**
 * Extracts the 65-byte uncompressed point from a P-256 SubjectPublicKeyInfo,
 * the format of `AuthenticatorAttestationResponse.getPublicKey()`.
 */
export function p256PublicKeyFromSpki(spki: Uint8Array): Uint8Array {
  const prefix = toHex(spki.subarray(0, spki.length - 65));
  const point = spki.subarray(spki.length - 65);
  if (prefix !== P256_SPKI_PREFIX || point[0] !== 0x04) {
    throw new Error("The passkey did not return an uncompressed P-256 public key");
  }
  return Uint8Array.from(point);
}

/**
 * Converts a DER-encoded ECDSA signature (what WebAuthn returns) into the
 * 64-byte `r || s` form Soroban's `secp256r1_verify` expects, with `s` in the
 * lower half of the group order: the host rejects high-S signatures.
 */
export function derToLowSRawSignature(der: Uint8Array): Uint8Array {
  let offset = 0;
  const expect = (tag: number) => {
    if (der[offset] !== tag) throw new Error("Malformed DER signature");
    offset += 1;
  };
  const readLength = () => {
    const length = der[offset];
    if (length === undefined || length > 0x7f) throw new Error("Malformed DER signature");
    offset += 1;
    return length;
  };
  const readInteger = () => {
    expect(0x02);
    const length = readLength();
    const value = der.subarray(offset, offset + length);
    if (value.length !== length) throw new Error("Malformed DER signature");
    offset += length;
    return bytesToBigInt(value);
  };

  expect(0x30);
  if (readLength() !== der.length - 2) throw new Error("Malformed DER signature");
  const r = readInteger();
  let s = readInteger();
  if (offset !== der.length || r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) {
    throw new Error("Malformed DER signature");
  }
  if (s > P256_N / 2n) s = P256_N - s;
  return concatBytes(bigIntTo32Bytes(r), bigIntTo32Bytes(s));
}
