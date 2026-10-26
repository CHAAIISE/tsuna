import type { NextRequest } from "next/server";
import { z } from "zod";
import { FleetError, applyPatch, proposePatch } from "@/lib/fleet/admin";
import { FLEET_IDS, isFleetId } from "@/lib/fleet/config";
import { readFleet } from "@/lib/fleet/read";
import { sessionAccount, signInRequired } from "@/lib/session/session";

export const maxDuration = 120;

const action = z.discriminatedUnion("action", [
  z.object({ fleet: z.enum(FLEET_IDS), action: z.literal("propose"), wasmHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ fleet: z.enum(FLEET_IDS), action: z.literal("apply") }),
]);

function failure(error: unknown): Response {
  if (error instanceof FleetError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof z.ZodError) return Response.json({ error: "Invalid request." }, { status: 400 });
  // SDK errors can embed signed envelopes: log the message only.
  console.error(error instanceof Error ? error.message : "Fleet request failed");
  return Response.json({ error: "Stellar did not respond. Try again in a moment." }, { status: 502 });
}

export async function GET(request: NextRequest) {
  const fleet = request.nextUrl.searchParams.get("fleet") ?? "demo";
  if (!isFleetId(fleet)) return Response.json({ error: "Unknown fleet." }, { status: 404 });
  try {
    const state = await readFleet(fleet);
    if (!state) return Response.json({ error: "This fleet is not deployed." }, { status: 404 });
    return Response.json({ state });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!sessionAccount(request)) return signInRequired("propose a patch");
    const body = action.parse(await request.json());
    const result = body.action === "propose" ? await proposePatch(body.fleet, body.wasmHash) : await applyPatch(body.fleet);
    return Response.json({ hash: result.hash, state: await readFleet(body.fleet) });
  } catch (error) {
    return failure(error);
  }
}
