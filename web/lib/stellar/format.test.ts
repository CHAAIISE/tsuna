import { describe, expect, it } from "vitest";
import {
  formatAge, formatBps, formatLimitBps, formatSharePrice, formatShares, formatUsdc, parseUsdc, ppsSeries, sharesFor, sharesValue, sparklinePath,
} from "./format";

describe("amounts", () => {
  it("formats base units as USDC, truncating extra decimals", () => {
    expect(formatUsdc(30_000_118_119n)).toBe("3,000.01");
    expect(formatUsdc("-5000000")).toBe("−0.50");
    expect(formatUsdc(0n)).toBe("0.00");
  });

  it("parses typed amounts into base units and rejects malformed input", () => {
    expect(parseUsdc("1,000")).toBe(10_000_000_000n);
    expect(parseUsdc("0.1234567")).toBe(1_234_567n);
    expect(parseUsdc("1.12345678")).toBeNull();
    expect(parseUsdc("abc")).toBeNull();
  });

  it("values shares at the price per share (scaled 10^18)", () => {
    // 100 USDC deposited at inception mints 10^18 raw shares; pps = 10^9.
    expect(sharesValue(10n ** 18n, 1_000_000_000n)).toBe(1_000_000_000n);
    expect(formatSharePrice(1_000_003_936n)).toBe("1.000003");
    expect(formatShares(10n ** 18n)).toBe("100.0000");
  });

  it("converts an amount into shares without exceeding what is owned", () => {
    expect(sharesFor(500_000_000n, 1_000_000_000n, 10n ** 18n)).toBe(5n * 10n ** 17n);
    expect(sharesFor(5_000_000_000n, 1_000_000_000n, 10n ** 18n)).toBe(10n ** 18n);
  });
});

describe("percentages and ages", () => {
  it("keeps enough decimals for tiny returns", () => {
    expect(formatBps(0)).toBe("0.00%");
    expect(formatBps(-0.86)).toBe("−0.0086%");
    expect(formatBps(45.537)).toBe("+0.455%");
    expect(formatBps(210_000)).toBe("+2100.00%");
    expect(formatBps(12, { signed: false })).toBe("0.120%");
  });

  it("prints limits as plain percentages", () => {
    expect(formatLimitBps(5_000)).toBe("50%");
    expect(formatLimitBps(50)).toBe("0.50%");
    expect(formatLimitBps(13_000)).toBe("130%");
  });

  it("rounds ages to minutes, hours, then days", () => {
    expect(formatAge(1_000, 1_000 + 120)).toBe("2 min");
    expect(formatAge(0, 5 * 3_600)).toBe("5 h");
    expect(formatAge(0, 3 * 86_400)).toBe("3 d");
  });
});

describe("sparklines", () => {
  it("draws a flat series at mid-height and spans the full width", () => {
    expect(sparklinePath([1], 100, 20)).toBe("M0.0,10.0 L100.0,10.0");
    expect(sparklinePath([0, 1], 100, 20)).toBe("M0.0,18.0 L100.0,2.0");
  });

  it("keeps sub-bps price moves visible", () => {
    expect(ppsSeries([{ pps: "1000000000" }, { pps: "1000000001" }])).toEqual([0, 1]);
  });
});
