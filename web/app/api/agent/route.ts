import { z } from "zod";
import { clientIp, rateLimit, releaseRateLimit } from "@/lib/sponsor/rate-limit";
import { tooManyRequests } from "@/lib/sponsor/http";
import { latestRun, prepareRun } from "@/lib/stellar/agent-runs";
import { failure, notFound } from "@/lib/stellar/http";
import { sessionAccount, signInRequired } from "@/lib/session/session";
import { tsuna } from "@/lib/stellar/client";
import { resolveVaultId } from "@/lib/stellar/vaults";

export const dynamic = "force-dynamic";
/** A run is at most six model steps plus their transactions. */
export const maxDuration = 300;

const HOUR = 60 * 60 * 1000;
const body = z.object({ vault: z.string().min(1).max(64) });

/** Returns the completed management cycle so its receipt does not depend on instance-local polling. */
export async function POST(request: Request): Promise<Response> {
  try {
    const account = sessionAccount(request);
    if (!account) return signInRequired("run the agent");
    const address = await resolveVaultId(body.parse(await request.json()).vault);
    if (!address) return notFound();
    if (await tsuna().vault(address).sharesOf(account) === 0n) {
      return Response.json({ error: "Only depositors of this vault can run its agent. Deposit first." }, { status: 403 });
    }
    const keys = [`agent-ip:${clientIp(request)}`, `agent-vault:${address}`, `agent-account:${account}`];
    const wait = rateLimit(keys[0] as string, 12, HOUR) || rateLimit(keys[1] as string, 20, HOUR) || rateLimit(keys[2] as string, 6, HOUR);
    if (wait) return tooManyRequests(wait);
    const signalsUrl = process.env.LEASH_SIGNALS_URL || new URL(request.url).origin;
    let prepared;
    try {
      prepared = prepareRun(address, signalsUrl);
    } catch (error) {
      // A refused start (already running, no key) does not cost the caller a run.
      for (const key of keys) releaseRateLimit(key);
      throw error;
    }
    const run = await prepared.task();
    return Response.json({ run });
  } catch (error) {
    return failure(error);
  }
}

/** Latest run of `?vault=` started on this server, with its live journal. */
export async function GET(request: Request): Promise<Response> {
  try {
    const address = await resolveVaultId(new URL(request.url).searchParams.get("vault") ?? "");
    if (!address) return notFound();
    return Response.json({ run: latestRun(address) });
  } catch (error) {
    return failure(error);
  }
}
