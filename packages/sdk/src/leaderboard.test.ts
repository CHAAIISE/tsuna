import { describe, expect, test } from "vitest";
import { rank, score, type Snapshot } from "./leaderboard.js";

const E18 = 10n ** 18n;
const series = (vault: string, pps: bigint[]): Snapshot[] =>
  pps.map((value, i) => ({ vault, nav: value * 100n, pps: value, ts: 1_000 + i * 60, ledger: 10 + i, txHash: `${vault}-${i}` }));

describe("leaderboard math", () => {
  test("return, worst drawdown and volatility of a price-per-share series", () => {
    // 1.00 → 1.10 → 0.99 → 1.20
    const row = score(series("A", [100n * E18 / 100n, 110n * E18 / 100n, 99n * E18 / 100n, 120n * E18 / 100n]));
    expect(row.returnBps).toBe(2_000);
    expect(row.worstDrawdownBps).toBe(1_000);
    // Step returns: +1000, −1000, +2121.212 bps; population standard deviation.
    const steps = [1_000, -1_000, 2_121.212];
    const mean = steps.reduce((a, b) => a + b) / steps.length;
    const expected = Math.sqrt(steps.reduce((a, r) => a + (r - mean) ** 2, 0) / steps.length);
    expect(row.volatilityBps).toBeCloseTo(expected, 2);
    expect(row.since).toBe(1_000);
    expect(row.nav).toBe(120n * E18);
    expect(row.snapshots).toHaveLength(4);
  });

  test("a single snapshot has no return, drawdown or volatility", () => {
    const row = score(series("B", [E18]));
    expect([row.returnBps, row.worstDrawdownBps, row.volatilityBps]).toEqual([0, 0, 0]);
  });

  test("a monotonic rise has no drawdown", () => {
    expect(score(series("C", [E18, E18 + 1n, E18 * 2n])).worstDrawdownBps).toBe(0);
  });

  test("ranks best return first", () => {
    const rows = [score(series("low", [E18, E18 - E18 / 100n])), score(series("high", [E18, E18 + E18 / 10n]))];
    expect(rank(rows).map(r => r.vault)).toEqual(["high", "low"]);
  });

  test("refuses an empty series", () => {
    expect(() => score([])).toThrow();
  });
});
