import "server-only";
import { ApiError } from "./http";

const busy = new Set<string>();

/** A signing account may have only one sequence-consuming operation in flight. */
export function reserveSource(source: string): () => void {
  if (busy.has(source)) throw new ApiError("This signing account is busy. Wait for the current operation, then try again.", 409);
  busy.add(source);
  return () => { busy.delete(source); };
}
