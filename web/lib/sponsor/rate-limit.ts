import "server-only";

const hits = new Map<string, number[]>();

/**
 * Sliding-window limiter kept in memory: enough to stop a single client from
 * draining the testnet relayer or faucet. Returns the number of seconds to
 * wait, or 0 when the hit is accepted and recorded.
 */
export function rateLimit(key: string, limit: number, windowMs: number): number {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(time => now - time < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return Math.ceil((windowMs - (now - (recent[0] ?? now))) / 1000);
  }
  recent.push(now);
  hits.set(key, recent);
  return 0;
}

/** Gives back the latest hit of `key`, for requests that did not go through. */
export function releaseRateLimit(key: string): void {
  hits.get(key)?.pop();
}

/** Client IP as seen behind the hosting proxy. */
export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}
