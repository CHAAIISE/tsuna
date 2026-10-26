import "server-only";
import { Leash, TESTNET, type LeashError } from "@leash/sdk";
import { rpc } from "@stellar/stellar-sdk";
import { after } from "next/server";
import { deployments } from "./deployments";
import type { TypedError } from "./types";

export const RPC_URL = process.env.STELLAR_RPC_URL || TESTNET.rpcUrl;
export const HORIZON_URL = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";

let client: Leash | undefined;

/** Read client of the Leash contracts on testnet (simulations only, nothing is signed). */
export function leash(): Leash {
  client ??= new Leash({ deployments, rpcUrl: RPC_URL, networkPassphrase: TESTNET.networkPassphrase });
  return client;
}

export const rpcServer = (): rpc.Server => leash().server;

export const typedError = (error: LeashError): TypedError => ({
  contract: error.contract, code: error.code, name: error.name, message: error.message,
});

/** Typed contract error carried by `error`, decoded by the SDK; null for other failures. */
export function decodeError(error: unknown): TypedError | null {
  const decoded = leash().decodeError(error);
  return decoded ? typedError(decoded) : null;
}

interface Entry<T> {
  value?: T;
  at: number;
  pending?: Promise<T>;
}

const entries = new Map<string, Entry<unknown>>();

/** Past this many TTLs a stale value is no longer served: the request waits for fresh data. */
const MAX_STALE_TTLS = 3;

/**
 * Runs `task` after the response is sent. On Vercel the function freezes once
 * the response is out, so a bare floating promise may never finish: `after`
 * keeps the invocation alive until the refresh settles. Outside a request
 * (scripts, tests) `after` throws and the task simply runs detached.
 */
function background(task: () => Promise<unknown>): void {
  const run = () => task().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Stale-while-revalidate memo: returns the cached value while it is younger
 * than `ttlMs`; past that, returns it still and refreshes after the response;
 * past `MAX_STALE_TTLS × ttlMs`, waits for the reload (stale value only if it
 * fails). Concurrent misses share one load. Testnet reads are slow (one
 * simulation per getter), so every screen goes through this.
 */
export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const entry = entries.get(key) as Entry<T> | undefined;
  const refresh = () => {
    const current = entries.get(key) as Entry<T> | undefined;
    if (current?.pending) return current.pending;
    const pending = load().then(
      value => { entries.set(key, { value, at: Date.now() }); return value; },
      (error: unknown) => {
        const stale = entries.get(key) as Entry<T> | undefined;
        if (stale) delete stale.pending;
        throw error;
      },
    );
    entries.set(key, { ...current, at: current?.at ?? 0, pending });
    return pending;
  };
  if (entry && "value" in entry) {
    const age = Date.now() - entry.at;
    if (age > ttlMs * MAX_STALE_TTLS) return refresh().catch(() => entry.value as T);
    if (age > ttlMs) background(refresh);
    return entry.value as T;
  }
  return refresh();
}

/** Drops cached reads whose key starts with `prefix`, after a write changed them. */
export function invalidate(prefix: string): void {
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
}
