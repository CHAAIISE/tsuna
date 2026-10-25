import { z } from "zod";
import { FleetError } from "@/lib/fleet/admin";
import { createChoice, publishAgent } from "@/lib/fleet/create";

/** Deploy, register and one adapter per protocol: four or five transactions in a row. */
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const published = await publishAgent(createChoice.parse(await request.json()));
    return Response.json(published);
  } catch (error) {
    if (error instanceof FleetError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof z.ZodError) return Response.json({ error: "Invalid request." }, { status: 400 });
    // SDK errors can embed signed envelopes: log the message only.
    console.error(error instanceof Error ? error.message : "Publishing failed");
    return Response.json({ error: "Stellar testnet did not respond. Try again in a moment." }, { status: 502 });
  }
}
