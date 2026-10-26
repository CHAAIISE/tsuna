import { xdr } from "@stellar/stellar-sdk";
import { keyData, signAuthEntry } from "./auth";
import { passkeyDeployment } from "./deployment";
import { fromBase64Url, toBase64Url } from "./encoding";
import { createPasskey, signWithPasskey } from "./webauthn";

/** A passkey account remembered on this device (public data only). */
export interface PasskeyAccount {
  /** Smart account address (`C…`). */
  account: string;
  credentialId: string;
  publicKey: string;
  /** Deployment transaction, null when the account already existed. */
  deployHash: string | null;
}

const STORAGE_KEY = "leash.passkey-account";
const CHANGE_EVENT = "tsuna:passkey-account";

/** Subscribes to changes of the remembered account, in this tab and others. */
export function subscribePasskeyAccount(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

/** Raw stored value, stable between changes as `useSyncExternalStore` requires. */
export function passkeyAccountSnapshot(): string | null {
  return window.localStorage.getItem(STORAGE_KEY);
}

export function parsePasskeyAccount(raw: string | null): PasskeyAccount | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PasskeyAccount;
  } catch {
    return null;
  }
}

function storePasskeyAccount(account: PasskeyAccount | null): void {
  if (account) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  else window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function forgetPasskeyAccount(): void {
  storePasskeyAccount(null);
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data as T;
}

/** Creates a passkey on this device and deploys its smart account, gas paid by the relayer. */
export async function createPasskeyAccount(): Promise<PasskeyAccount> {
  const passkey = await createPasskey();
  const credentialId = toBase64Url(passkey.credentialId);
  const publicKey = toBase64Url(passkey.publicKey);
  const { account, hash } = await api<{ account: string; hash: string | null }>("/api/sponsor", { action: "deploy", publicKey, credentialId });
  const stored: PasskeyAccount = { account, credentialId, publicKey, deployHash: hash };
  storePasskeyAccount(stored);
  return stored;
}

/**
 * Calls `contract.method(args)` from the passkey account: the relayer
 * simulates the call, the passkey signs each authorization entry, and the
 * relayer submits and pays the fee.
 */
export async function invokeWithPasskey(
  owner: PasskeyAccount,
  call: { contract: string; method: string; args: xdr.ScVal[] },
): Promise<{ hash: string }> {
  const invocation = {
    account: owner.account,
    contract: call.contract,
    method: call.method,
    args: call.args.map(arg => arg.toXDR("base64")),
  };
  const { authEntries, validUntilLedger } = await api<{ authEntries: string[]; validUntilLedger: number }>(
    "/api/sponsor", { action: "prepare", ...invocation },
  );
  const credentialId = fromBase64Url(owner.credentialId);
  const signer = {
    account: owner.account,
    verifier: passkeyDeployment.verifier,
    keyData: keyData(fromBase64Url(owner.publicKey), credentialId),
    sign: (challenge: Uint8Array) => signWithPasskey(credentialId, challenge),
  };
  const signed: string[] = [];
  for (const entry of authEntries) {
    const authorized = await signAuthEntry(xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64"), signer, validUntilLedger);
    signed.push(authorized.toXDR("base64"));
  }
  return api<{ hash: string }>("/api/sponsor", { action: "submit", ...invocation, authEntries: signed });
}

export async function requestTestUsdc(address: string): Promise<{ hash: string; amount: bigint }> {
  const { hash, amount } = await api<{ hash: string; amount: string }>("/api/faucet", { address });
  return { hash, amount: BigInt(amount) };
}

/** On-chain USDC balance; null when a classic account has no USDC trustline. */
export async function readUsdcBalance(address: string): Promise<bigint | null> {
  const { balance } = await api<{ balance: string | null }>(`/api/faucet?address=${encodeURIComponent(address)}`);
  return balance === null ? null : BigInt(balance);
}
