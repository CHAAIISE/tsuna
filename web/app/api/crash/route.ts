import { after } from "next/server";
import { z } from "zod";
import { crashState, startStep } from "@/lib/crash/run";
import { CRASH_STEP_IDS } from "@/lib/crash/types";
import { tooManyRequests } from "@/lib/sponsor/http";
import { clientIp, rateLimit, releaseRateLimit } from "@/lib/sponsor/rate-limit";
import { failure } from "@/lib/stellar/http";
import { sessionAccount, signInRequired } from "@/lib/session/session";

export const dynamic = "force-dynamic";
/** The risk-off step is up to two model runs plus their transactions. */
export const maxDuration = 300;

const HOUR = 60 * 60 * 1000;
const body = z.object({ step: z.enum(CRASH_STEP_IDS) });

/** Live health factor, NAV, pause and demo price of the crash vault, with the current run (`?vault=` any vault id). */
export async function GET(request: Request): Promise<Response> {
  try {
    const { body: state, task } = await crashState(new URL(request.url).searchParams.get("vault"));
    if (task) after(task);
    return Response.json(state);
  } catch (error) {
    return failure(error);
  }
}

/**
 * Runs one step of the crash demo after the response; GET shows its outcome. One run at a time
 * per server, and new runs are rate-limited per client and overall.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!sessionAccount(request)) return signInRequired("drive the crash");
    const { step } = body.parse(await request.json());
    const ip = clientIp(request);
    const keys = step === "prepare" ? [`crash-run-ip:${ip}`, "crash-runs"] : [`crash-step-ip:${ip}`];
    const wait = step === "prepare"
      ? rateLimit(`crash-run-ip:${ip}`, 6, HOUR) || rateLimit("crash-runs", 20, HOUR)
      : rateLimit(`crash-step-ip:${ip}`, 80, HOUR);
    if (wait) return tooManyRequests(wait);
    let started;
    try {
      started = await startStep(step);
    } catch (error) {
      // A refused step (busy, out of order, nothing to restore) does not count against the caller.
      for (const key of keys) releaseRateLimit(key);
      throw error;
    }
    after(started.task);
    return Response.json({ run: started.run }, { status: 202 });
  } catch (error) {
    return failure(error);
  }
}
