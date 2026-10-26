import "server-only";
import { z } from "zod";

/** An error whose message and status can go back to the browser. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** JSON error for the vault and agent routes; RPC failures are logged, not echoed. */
export function failure(error: unknown): Response {
  if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError) return Response.json({ error: "Invalid request." }, { status: 400 });
  console.error(error instanceof Error ? error.message : error);
  return Response.json({ error: "Stellar did not respond. Try again in a moment." }, { status: 502 });
}

export const notFound = () => Response.json({ error: "No vault with this id." }, { status: 404 });
