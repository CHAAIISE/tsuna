import { describe, expect, it } from "vitest";
import { reserveRates, type BlendReserve } from "./blend-rates";

// Reserve configuration and expected rates from Blend v2 `interest.rs` tests:
// each accrual there equals 1 + rate * 500 s / one year.
const reserve = (dSupply: bigint): BlendReserve => ({
  config: { decimals: 7, util: 7_500_000, r_base: 100_000, r_one: 500_000, r_two: 5_000_000, r_three: 15_000_000 },
  data: { b_rate: 1_000_000_000_000n, d_rate: 1_000_000_000_000n, b_supply: 10_000_000_000n, d_supply: dSupply, ir_mod: 10_000_000n, last_time: 0n },
});
const accrualOver500s = (rate: number) => Math.round((1 + rate * 500 / 31_536_000) * 1e12);
// Blend rounds its fixed-point products up, so the float model may differ by a few 1e-12 units.
const expectAccrual = (rate: number, blend: number) => expect(Math.abs(accrualOver500s(rate) - blend)).toBeLessThanOrEqual(3);

describe("reserveRates", () => {
  it("matches Blend under the target utilization", () => {
    const rates = reserveRates(reserve(6_565_656_000n), 0);
    expect(rates.utilization).toBeCloseTo(0.6565656, 7);
    expectAccrual(rates.borrowApr, 1_000_000_852_536);
  });

  it("matches Blend between the target and 95% utilization", () => {
    expectAccrual(reserveRates(reserve(7_979_797_000n), 0).borrowApr, 1_000_002_853_078);
  });

  it("matches Blend above 95% utilization", () => {
    expectAccrual(reserveRates(reserve(9_696_969_000n), 0).borrowApr, 1_000_018_247_510);
  });

  it("gives lenders the borrower interest net of the backstop take rate", () => {
    const rates = reserveRates(reserve(5_000_000_000n), 2_000_000);
    expect(rates.supplyApr).toBeCloseTo(rates.borrowApr * 0.5 * 0.8, 12);
    expect(rates.totalSupplied).toBe(10_000_000_000n);
    expect(rates.totalBorrowed).toBe(5_000_000_000n);
  });

  it("reports zero utilization for an empty reserve", () => {
    const empty = { ...reserve(0n), data: { ...reserve(0n).data, b_supply: 0n } };
    expect(reserveRates(empty, 0)).toMatchObject({ utilization: 0, supplyApr: 0 });
  });
});
