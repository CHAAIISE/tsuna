import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

/** One `NavSnapshot` event of a vault. */
export interface Snapshot {
  vault: string;
  /** Base-asset units (7 decimals). */
  nav: bigint;
  /** Base-asset units per raw share, scaled by 10^18. */
  pps: bigint;
  /** Ledger close time, seconds since the epoch. */
  ts: number;
  ledger: number;
  txHash: string;
}

export interface LeaderboardRow {
  vault: string;
  /** Return of the price per share from the first to the last snapshot, in bps. */
  returnBps: number;
  /** Largest fall of the price per share from a previous peak, in bps (0 if none). */
  worstDrawdownBps: number;
  /** Population standard deviation of snapshot-to-snapshot returns, in bps. */
  volatilityBps: number;
  /**
   * Timestamp of the first snapshot still retained by the RPC (about 7 days on testnet):
   * "since inception" only when the vault is younger than that window.
   */
  since: number;
  nav: bigint;
  pps: bigint;
  snapshots: Snapshot[];
}

/** `(value - base) / base` in bps, to a thousandth of a bp. */
const changeBps = (value: bigint, base: bigint) => Number((value - base) * 10_000_000n / base) / 1_000;

/** Return, drawdown and volatility of time-ordered `snapshots` of one vault (at least one). */
export function score(snapshots: Snapshot[]): LeaderboardRow {
  const first = snapshots[0];
  const last = snapshots.at(-1);
  if (!first || !last) throw new Error("A leaderboard row needs at least one snapshot");
  let peak = first.pps;
  let worst = 0;
  const returns: number[] = [];
  snapshots.forEach(({ pps }, i) => {
    if (pps > peak) peak = pps;
    if (peak > 0n) worst = Math.max(worst, -changeBps(pps, peak));
    const previous = snapshots[i - 1];
    if (previous && previous.pps > 0n) returns.push(changeBps(pps, previous.pps));
  });
  const mean = returns.reduce((sum, r) => sum + r, 0) / (returns.length || 1);
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length || 1);
  return {
    vault: first.vault,
    returnBps: first.pps > 0n ? changeBps(last.pps, first.pps) : 0,
    worstDrawdownBps: worst,
    volatilityBps: Math.sqrt(variance),
    since: first.ts,
    nav: last.nav,
    pps: last.pps,
    snapshots,
  };
}

/** Rows sorted by return, best first. */
export function rank(rows: LeaderboardRow[]): LeaderboardRow[] {
  return [...rows].sort((a, b) => b.returnBps - a.returnBps);
}

const NAV_SNAPSHOT = xdr.ScVal.scvSymbol("nav_snapshot").toXDR("base64");
/** `getEvents` accepts at most 5 contract ids per filter. */
const IDS_PER_FILTER = 5;
const PAGE = 1_000;

function snapshotOf(event: rpc.Api.EventResponse): Snapshot {
  const data = scValToNative(event.value) as { nav: bigint; pps: bigint; ts: bigint };
  return {
    vault: event.contractId?.contractId() ?? "",
    nav: data.nav, pps: data.pps, ts: Number(data.ts), ledger: event.ledger, txHash: event.txHash,
  };
}

/**
 * Every `NavSnapshot` of `vaults` the RPC still retains (about 7 days on testnet), oldest first,
 * following the pagination cursor to the end.
 */
export async function fetchSnapshots(server: rpc.Server, vaults: string[]): Promise<{ snapshots: Snapshot[]; oldestLedger: number }> {
  const { oldestLedger } = await server.getHealth();
  const snapshots: Snapshot[] = [];
  for (let i = 0; i < vaults.length; i += IDS_PER_FILTER) {
    const filters: rpc.Api.EventFilter[] = [{
      type: "contract", contractIds: vaults.slice(i, i + IDS_PER_FILTER), topics: [[NAV_SNAPSHOT, "**"]],
    }];
    let page = await server.getEvents({ startLedger: oldestLedger, filters, limit: PAGE });
    for (;;) {
      snapshots.push(...page.events.map(snapshotOf));
      if (page.events.length < PAGE) break;
      page = await server.getEvents({ cursor: page.cursor, filters, limit: PAGE });
    }
  }
  snapshots.sort((a, b) => a.ledger - b.ledger || a.ts - b.ts);
  return { snapshots, oldestLedger };
}
