import { parsePasskeyAccount, passkeyAccountSnapshot } from "./client";
import { fromBase64Url, toBase64Url } from "./encoding";
import { signWithPasskey } from "./webauthn";

/**
 * Makes sure the server holds a session for this browser's passkey account, asking the passkey to
 * sign a server challenge when it does not. Actions that spend the server's keys or model credits
 * (running an agent, the crash, publishing, fleet patches) require it.
 */
export async function ensureSession(action: string): Promise<void> {
  const account = parsePasskeyAccount(passkeyAccountSnapshot());
  if (!account) throw new Error(`Sign in with your passkey to ${action}.`);
  const state = await (await fetch("/api/session", { cache: "no-store" })).json() as { account?: string | null; challenge?: string; error?: string };
  if (state.account === account.account) return;
  if (!state.challenge) throw new Error(state.error ?? "Sign-in is unavailable right now.");
  const assertion = await signWithPasskey(fromBase64Url(account.credentialId), new TextEncoder().encode(state.challenge));
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: account.publicKey,
      credentialId: account.credentialId,
      authenticatorData: toBase64Url(assertion.authenticatorData),
      clientDataJSON: toBase64Url(assertion.clientDataJSON),
      signature: toBase64Url(assertion.signature),
    }),
  });
  const result = await response.json().catch(() => ({})) as { account?: string; error?: string };
  if (!response.ok || result.account !== account.account) throw new Error(result.error ?? "The passkey sign-in failed.");
}
