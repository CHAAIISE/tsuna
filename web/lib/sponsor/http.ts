import "server-only";
import { z } from "zod";
import { SponsorError } from "./stellar";

export function errorResponse(error: unknown): Response {
  if (error instanceof SponsorError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError) return Response.json({ error: "Invalid request." }, { status: 400 });
  // SDK errors can embed signed envelopes: log the message only.
  const message = error instanceof Error ? error.message
    : typeof error === "object" && error !== null && "message" in error ? String(error.message) : "Unknown sponsor failure";
  console.error(message);
  return Response.json({ error: "Stellar did not respond. Try again in a moment." }, { status: 502 });
}

export function tooManyRequests(retryAfter: number): Response {
  return Response.json(
    { error: `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} min.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
