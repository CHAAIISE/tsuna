import { z } from "zod";
import { clearedSessionCookie, newChallenge, recoverSignIn, sessionAccount, sessionCookie, verifySignIn } from "@/lib/session/session";
import { failure } from "@/lib/stellar/http";

export const dynamic = "force-dynamic";

const b64 = z.string().min(1).max(4096);
const assertion = z.object({ credentialId: b64, authenticatorData: b64, clientDataJSON: b64, signature: b64 });
const body = z.union([assertion.extend({ publicKey: b64 }), assertion]);

/** The signed-in account, if any, and a fresh challenge to sign in with. */
export function GET(request: Request): Response {
  try {
    return Response.json({ account: sessionAccount(request), challenge: newChallenge() });
  } catch (error) {
    return failure(error);
  }
}

/**
 * Opens a session from a passkey assertion over a challenge from GET. Without `publicKey` (a browser
 * that does not remember the account), the account is recovered from the signature and returned with its key.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = body.parse(await request.json());
    const origin = new URL(request.url).origin;
    const signedIn = "publicKey" in input ? { account: verifySignIn(input, origin), publicKey: input.publicKey } : await recoverSignIn(input, origin);
    return Response.json(signedIn, { headers: { "Set-Cookie": sessionCookie(signedIn.account) } });
  } catch (error) {
    return failure(error);
  }
}

export function DELETE(): Response {
  return Response.json({ account: null }, { headers: { "Set-Cookie": clearedSessionCookie } });
}
