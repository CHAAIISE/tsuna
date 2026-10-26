import { z } from "zod";
import { clearedSessionCookie, newChallenge, sessionAccount, sessionCookie, verifySignIn } from "@/lib/session/session";
import { failure } from "@/lib/stellar/http";

export const dynamic = "force-dynamic";

const b64 = z.string().min(1).max(4096);
const body = z.object({ publicKey: b64, credentialId: b64, authenticatorData: b64, clientDataJSON: b64, signature: b64 });

/** The signed-in account, if any, and a fresh challenge to sign in with. */
export function GET(request: Request): Response {
  try {
    return Response.json({ account: sessionAccount(request), challenge: newChallenge() });
  } catch (error) {
    return failure(error);
  }
}

/** Opens a session from a passkey assertion over a challenge from GET. */
export async function POST(request: Request): Promise<Response> {
  try {
    const account = verifySignIn(body.parse(await request.json()), new URL(request.url).origin);
    return Response.json({ account }, { headers: { "Set-Cookie": sessionCookie(account) } });
  } catch (error) {
    return failure(error);
  }
}

export function DELETE(): Response {
  return Response.json({ account: null }, { headers: { "Set-Cookie": clearedSessionCookie } });
}
