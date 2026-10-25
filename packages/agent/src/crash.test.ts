import { Keypair } from "@stellar/stellar-sdk";
import { parseDeployments } from "@leash/sdk";
import { describe, expect, it } from "vitest";
import { CrashError, CrashScenario, budgetRepayAmount, refusedBorrowAmount } from "./crash.js";

const UNIT = 10_000_000n;
const FLOOR = 13_000n;

describe("crash amounts", () => {
  it("sizes the refused borrow to land near a 1.2 health factor", () => {
    // 10 USDC of debt at 1.5: 12.5 USDC of debt gives 1.2.
    expect(refusedBorrowAmount(10n * UNIT, 15_000n)).toBe(25n * UNIT / 10n);
  });

  it("borrows dust once the health factor is already under 1.2", () => {
    expect(refusedBorrowAmount(10n * UNIT, 10_090n)).toBe(UNIT / 100n);
  });

  it("budgets with a dust repay while the book is well above the floor", () => {
    expect(budgetRepayAmount(10n * UNIT, 20_000n, FLOOR)).toBe(UNIT / 100n);
  });

  it("budgets with a repay that lifts the health factor back over the floor", () => {
    const debt = 10n * UNIT;
    const health = 10_090n;
    const repay = budgetRepayAmount(debt, health, FLOOR);
    expect(health * debt / (debt - repay)).toBeGreaterThanOrEqual(FLOOR * 11n / 10n);
    expect(repay).toBeLessThan(debt);
  });

  it("repays the whole debt at most", () => {
    expect(budgetRepayAmount(10n * UNIT, 1n, FLOOR)).toBe(10n * UNIT);
  });
});

describe("CrashScenario", () => {
  const key = () => Keypair.random();
  const deployments = parseDeployments({
    network: "testnet",
    keeper: key().publicKey(),
    oracleRouter: "CROUTER",
    vaults: [{ id: "leverage", name: "Leverage", address: "CLEVERAGE" }],
  });
  const scenario = () => new CrashScenario({
    deployments, keys: { admin: key(), agent: key(), riskoff: key(), keeper: key(), depositor: key() },
  });

  it("starts with the preparation and refuses steps out of order", async () => {
    const crash = scenario();
    expect(crash.next()).toBe("prepare");
    expect(crash.needsRestore).toBe(false);
    await expect(crash.run("crash")).rejects.toThrow(CrashError);
    await expect(crash.run("crash")).rejects.toThrow("next is prepare");
  });

  it("refuses a vault missing from the deployments", () => {
    expect(() => new CrashScenario({ deployments, vault: "prudent", keys: { admin: key(), agent: key(), riskoff: key(), keeper: key(), depositor: key() } }))
      .toThrow("prudent");
  });
});
