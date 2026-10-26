import "server-only";
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { ApiError } from "@/lib/stellar/http";
import { fromBase64Url, toBase64Url } from "@/lib/passkey/encoding";
import { passkeyAccountAddress } from "@/lib/sponsor/relayer";
import { passkeyDeployment } from "@/lib/passkey/deployment";
import { contractWasmHash } from "@/lib/sponsor/stellar";
import { p256 } from "@noble/curves/p256";

/**
 * Proof that the caller controls a passkey account, kept in an HttpOnly cookie.
 * The account address is derived from its public key, so a valid WebAuthn assertion over a fresh
 * server challenge, from the key the address commits to, proves control without any stored state.
 */

export const SESSION_COOKIE = "tsuna_session";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_S = 7 * 24 * 60 * 60;
/** WebAuthn authenticator data flags: user present, user verified. */
const UP = 0x01;
const UV = 0x04;

function key(): Buffer {
  const secret = process.env.LEASH_RELAYER_SECRET;
  if (!secret) throw new ApiError("Sign-in is not configured on this server.", 503);
  return createHash("sha256").update(`tsuna-session:${secret}`).digest();
}

const mac = (value: string) => createHmac("sha256", key()).update(value).digest("base64url");

function sameMac(value: string, given: string): boolean {
  const expected = Buffer.from(mac(value));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A stateless, signed, short-lived challenge for the passkey to sign. */
export function newChallenge(): string {
  const body = `${Date.now()}.${randomBytes(16).toString("base64url")}`;
  return `${body}.${mac(body)}`;
}

function checkChallenge(challenge: string): void {
  const [issued, nonce, tag] = challenge.split(".");
  if (!issued || !nonce || !tag || !sameMac(`${issued}.${nonce}`, tag)) throw new ApiError("Unknown sign-in challenge.", 401);
  if (Date.now() - Number(issued) > CHALLENGE_TTL_MS) throw new ApiError("The sign-in challenge expired. Try again.", 401);
}

export interface Assertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export interface SignIn extends Assertion {
  publicKey: string;
}

/** Checks what the assertion vouches for (this site, a fresh challenge, a verified user) and returns the signed bytes. */
function signedBytes(input: Assertion, origin: string): { signed: Buffer; signature: Uint8Array; credentialId: Uint8Array } {
  const credentialId = fromBase64Url(input.credentialId);
  const authenticatorData = fromBase64Url(input.authenticatorData);
  const clientDataJSON = fromBase64Url(input.clientDataJSON);
  const signature = fromBase64Url(input.signature);
  if (signature.length !== 64 || authenticatorData.length < 37 || credentialId.length === 0) throw new ApiError("Malformed passkey signature.", 400);

  const client = JSON.parse(new TextDecoder().decode(clientDataJSON)) as { type?: string; challenge?: string; origin?: string };
  if (client.type !== "webauthn.get" || client.origin !== origin || !client.challenge) throw new ApiError("The passkey signed for another site.", 401);
  checkChallenge(new TextDecoder().decode(fromBase64Url(client.challenge)));
  const flags = authenticatorData[32] ?? 0;
  if ((flags & UP) === 0 || (flags & UV) === 0) throw new ApiError("The passkey did not verify the user.", 401);
  return { signed: Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), signature, credentialId };
}

/**
 * True when `account` is a Tsuna passkey account on-chain. Its address commits to the key it was
 * deployed with (the relayer's salt is the key's hash), so a deployed account at the address derived
 * from a key is that key's account: a valid signature from a key without one proves nothing.
 */
async function isPasskeyAccount(account: string): Promise<boolean> {
  return (await contractWasmHash(account)) === passkeyDeployment.accountWasmHash;
}

/** Verifies a passkey assertion over a server challenge and returns the account it controls. */
export async function verifySignIn(input: SignIn, origin: string): Promise<string> {
  const publicKey = fromBase64Url(input.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new ApiError("Malformed passkey signature.", 400);
  const { signed, signature, credentialId } = signedBytes(input, origin);
  const jwk = { kty: "EC", crv: "P-256", x: toBase64Url(publicKey.subarray(1, 33)), y: toBase64Url(publicKey.subarray(33)) };
  const valid = verify("sha256", signed, { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, signature);
  if (!valid) throw new ApiError("The passkey signature is invalid.", 401);
  const account = passkeyAccountAddress(publicKey, credentialId);
  if (!(await isPasskeyAccount(account))) throw new ApiError("No Tsuna account uses this passkey. Create one first.", 404);
  return account;
}

/**
 * Finds the account of a passkey from a single assertion, for a browser that never stored it.
 * A P-256 signature determines its public key up to two candidates; the account address commits to
 * the key, so the candidate whose account is deployed on-chain is the one.
 */
export async function recoverSignIn(input: Assertion, origin: string): Promise<{ account: string; publicKey: string }> {
  const { signed, signature, credentialId } = signedBytes(input, origin);
  const digest = createHash("sha256").update(signed).digest();
  for (const bit of [0, 1]) {
    let publicKey: Uint8Array;
    try {
      publicKey = p256.Signature.fromCompact(signature).addRecoveryBit(bit).recoverPublicKey(digest).toRawBytes(false);
    } catch {
      continue;
    }
    const account = passkeyAccountAddress(publicKey, credentialId);
    if (await isPasskeyAccount(account)) return { account, publicKey: toBase64Url(publicKey) };
  }
  throw new ApiError("No Tsuna account uses this passkey. Create one first.", 404);
}

/** `Set-Cookie` value opening a session for `account`. */
export function sessionCookie(account: string): string {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const value = `${account}.${expires}.${mac(`${account}.${expires}`)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The account of the request's session, or null. */
export function sessionAccount(request: Request): string | null {
  const cookie = request.headers.get("cookie")?.split(/;\s*/).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  const [account, expires, tag] = cookie?.slice(SESSION_COOKIE.length + 1).split(".") ?? [];
  if (!account || !expires || !tag || !sameMac(`${account}.${expires}`, tag)) return null;
  return Number(expires) * 1000 > Date.now() ? account : null;
}

/** 401 for a request without a session; the client answers it with a passkey prompt. */
export const signInRequired = (action: string): Response => Response.json({ error: `Sign in with your passkey to ${action}.` }, { status: 401 });
