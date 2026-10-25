import { timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Leash, parseDeployments } from "@leash/sdk";
import { runKeeper } from "@leash/agent/keeper";
import deployments from "../../../../deployments/testnet.json";

// One pass sends up to two transactions per vault and waits for each.
export const maxDuration = 300;

function authorized(request: Request): boolean {
  const token = process.env.KEEPER_TOKEN;
  if (!token) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Runs one keeper pass over the fleet: protocol upgrade watch, then `check_drawdown` (which
 * also records a NAV snapshot) on every vault. Requires `Authorization: Bearer $KEEPER_TOKEN`;
 * GET is accepted so a scheduler can call it.
 */
async function keep(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Missing or wrong keeper token." }, { status: 401 });
  const secret = process.env.LEASH_KEEPER_SECRET;
  if (!secret) return Response.json({ error: "The keeper key is not configured." }, { status: 503 });
  try {
    const report = await runKeeper({
      leash: new Leash({ deployments: parseDeployments(deployments) }),
      keeper: Keypair.fromSecret(secret),
    });
    return Response.json(report);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Keeper pass failed." }, { status: 502 });
  }
}

export { keep as GET, keep as POST };
