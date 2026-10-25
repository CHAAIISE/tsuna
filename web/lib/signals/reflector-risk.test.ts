import { describe, expect, it } from "vitest";
import { riskSignal, type PricePoint } from "./reflector-risk";

const DECIMALS = 14;
const point = (usd: number, timestamp: number): PricePoint => ({ price: BigInt(Math.round(usd * 1e6)) * 10n ** 8n, timestamp: BigInt(timestamp) });
const NOW = 1_800_000_000;
const flatRecent = Array.from({ length: 13 }, (_, index) => point(0.2, NOW - index * 300));

describe("riskSignal", () => {
  it("reports changes over one hour and over the retained window", () => {
    const hourly = Array.from({ length: 24 }, (_, index) => index < 22 ? point(index === 0 ? 0.19 : 0.18, NOW - (index + 1) * 3600) : null);
    const signal = riskSignal({ decimals: DECIMALS, resolution: 300, recent: flatRecent, hourly, usdc: point(1.0005, NOW) });
    expect(signal.price).toBeCloseTo(0.2, 10);
    expect(signal.change1h).toBeCloseTo(0.2 / 0.19 - 1, 10);
    expect(signal.changeWindow).toEqual({ hours: 22, change: expect.closeTo(0.2 / 0.18 - 1, 10) });
    expect(signal.usdcPegDeviationBps).toBeCloseTo(5, 6);
    expect(signal.level).toBe("high");
  });

  it("annualizes the standard deviation of log returns", () => {
    const recent = Array.from({ length: 13 }, (_, index) => point(index % 2 === 0 ? 0.2 : 0.202, NOW - index * 300));
    const hourly = Array.from({ length: 24 }, (_, index) => point(0.2, NOW - (index + 1) * 3600));
    const signal = riskSignal({ decimals: DECIMALS, resolution: 300, recent, hourly, usdc: point(1, NOW) });
    const step = Math.log(0.202 / 0.2);
    // Alternating +step/-step returns: mean 0, sample variance step^2 * n / (n - 1) with n = 12.
    const expected = Math.sqrt(step ** 2 * 12 / 11) * Math.sqrt(365 * 24 * 12);
    expect(signal.volatility.fiveMinuteAnnualized).toBeCloseTo(expected, 10);
    expect(signal.volatility.fiveMinuteReturns).toBe(12);
    expect(signal.volatility.hourlyAnnualized).toBe(0);
    expect(signal.level).toBe("high");
  });

  it("is low for a flat market", () => {
    const hourly = Array.from({ length: 24 }, (_, index) => point(0.2, NOW - (index + 1) * 3600));
    const signal = riskSignal({ decimals: DECIMALS, resolution: 300, recent: flatRecent, hourly, usdc: point(1, NOW) });
    expect(signal).toMatchObject({ change1h: 0, changeWindow: { hours: 24, change: 0 }, level: "low" });
  });

  it("leaves changes undefined when the oracle retained no history", () => {
    const signal = riskSignal({ decimals: DECIMALS, resolution: 300, recent: flatRecent, hourly: Array(24).fill(null), usdc: point(1, NOW) });
    expect(signal).toMatchObject({ change1h: null, changeWindow: null, level: "low" });
    expect(signal.volatility.hourlyAnnualized).toBeNull();
  });
});
