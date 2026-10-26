import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Account, Address, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

/**
 * Drives the crash demo of the Leverage vault end to end on testnet: every step is a real
 * transaction, and the test reads each outcome back from the chain. The last step restores the
 * price and lifts the pause, so the vault is left as it was found.
 */
const fleet = JSON.parse(readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8")) as {
  oracleRouter: string;
  keeper: string;
  vaults: { id: string; address: string }[];
};
const leverage = fleet.vaults.find(vault => vault.id === "leverage");
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const STEP_TIMEOUT = 300_000;
const server = new rpc.Server("https://soroban-testnet.stellar.org");

/** The public testnet RPC answers 502 now and then: retry a read a few times. */
async function retry<T>(task: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(attempt * 2_000);
    }
  }
}

async function read<T>(contract: string, fn: string): Promise<T> {
  const tx = new TransactionBuilder(new Account(fleet.keeper, "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contract).call(fn))
    .setTimeout(30)
    .build();
  const simulation = await retry(() => server.simulateTransaction(tx));
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) throw new Error(`${fn} simulation failed`);
  return scValToNative(simulation.result.retval) as T;
}

/** XLM price forced on the demo oracle, `null` when none. */
async function forcedPrice(): Promise<bigint | null> {
  const key = xdr.ScVal.scvVec([nativeToScVal("Price", { type: "symbol" }), new Address(XLM).toScVal()]);
  const entry = await retry(() => server.getContractData(fleet.oracleRouter, key, rpc.Durability.Persistent).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 404) return null;
    throw error;
  }));
  return entry?.val.type === "contractData" ? scValToNative(entry.val.contractData.val) as bigint : null;
}

const status = async (hash: string) => (await retry(() => server.getTransaction(hash))).status;

async function runStep(page: Page, id: string): Promise<void> {
  await page.getByTestId(`crash-run-${id}`).click();
  await expect(page.getByTestId(`crash-step-${id}`)).toHaveAttribute("data-state", "done", { timeout: STEP_TIMEOUT });
}

async function hashes(page: Page, id: string, testId: "crash-tx" | "crash-wall"): Promise<string[]> {
  return page.getByTestId(`crash-step-${id}`).getByTestId(testId).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-hash") ?? ""));
}

const crashResponse = z.object({
  run: z.object({
    busy: z.string().nullable(),
    needsRestore: z.boolean(),
    steps: z.array(z.object({ id: z.string(), status: z.string(), error: z.string().nullable() })),
  }).nullable(),
});

test.afterEach(async ({ request }) => {
  let state: z.infer<typeof crashResponse> | undefined;
  await expect.poll(async () => {
    const response = await request.get("/api/crash?vault=leverage");
    expect(response.ok()).toBe(true);
    state = crashResponse.parse(await response.json());
    return state.run?.busy ?? null;
  }, { timeout: STEP_TIMEOUT, intervals: [2_000] }).toBeNull();
  if (state?.run?.needsRestore) {
    const restored = await request.post("/api/crash", { data: { step: "restore" } });
    expect(restored.status()).toBe(202);
    await expect.poll(async () => {
      const response = await request.get("/api/crash?vault=leverage");
      expect(response.ok()).toBe(true);
      const current = crashResponse.parse(await response.json());
      return current.run?.steps.find(step => step.id === "restore")?.status;
    }, { timeout: STEP_TIMEOUT, intervals: [2_000] }).toBe("done");
    expect(await forcedPrice()).toBeNull();
    if (leverage) expect(await read<boolean>(leverage.address, "paused")).toBe(false);
  }
});

test("a 30 % XLM crash: both risky calls hit the wall, the vault pauses, a depositor still withdraws, then the price is restored", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  if (!leverage) throw new Error("No Leverage vault in deployments/testnet.json");

  await page.goto("/agents/leverage");
  const panel = page.getByTestId("crash-panel");
  await expect(panel).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("demo-oracle-banner")).toContainText("Demo oracle — testnet only");
  await expect(page.getByTestId("crash-health")).toBeVisible();

  // A run left crashed by someone else is restored first; a finished one is started again.
  for (const leftover of ["crash-stop", "crash-run-restore"]) {
    if (await page.getByTestId(leftover).isVisible()) {
      await page.getByTestId(leftover).click();
      await expect(page.getByTestId("crash-again")).toBeVisible({ timeout: STEP_TIMEOUT });
    }
  }
  expect(await read<boolean>(leverage.address, "paused")).toBe(false);
  expect(await forcedPrice()).toBeNull();
  if (await page.getByTestId("crash-again").isVisible()) await page.getByTestId("crash-again").click();
  else await page.getByTestId("crash-run-prepare").click();
  // A finished run still shows its own steps as done until the new one starts.
  const prepare = page.getByTestId("crash-step-prepare");
  await expect(prepare).toHaveAttribute("data-state", "running", { timeout: 60_000 });
  await expect(prepare).toHaveAttribute("data-state", "done", { timeout: STEP_TIMEOUT });
  const log: string[] = [`PREPARE ${(await hashes(page, "prepare", "crash-tx")).join(" ")}`];

  await test.step("08 · drop the demo oracle's XLM price by 30 %", async () => {
    await runStep(page, "crash");
    await expect(page.getByTestId("crash-xlm-price").locator("..")).toContainText("Forced by the demo oracle", { timeout: 30_000 });
    expect(await forcedPrice()).not.toBeNull();
    log.push(`CRASH ${(await hashes(page, "crash", "crash-tx")).join(" ")}`);
  });

  await test.step("the yield agent's borrow hits HealthFactorTooLow", async () => {
    await runStep(page, "yield-refused");
    const wall = page.getByTestId("crash-step-yield-refused").getByTestId("crash-wall");
    await expect(wall).toHaveAttribute("data-error", "HealthFactorTooLow");
    const [hash = ""] = await hashes(page, "yield-refused", "crash-wall");
    await expect(wall.getByTestId("crash-tx-link")).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(await status(hash)).toBe("FAILED");
    log.push(`HF_REFUSED ${hash}`);
  });

  await test.step("the keeper's check_drawdown pauses the vault", async () => {
    await runStep(page, "pause");
    await expect(page.getByTestId("crash-pause-badge")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("crash-paused")).toBeVisible();
    await expect(page.getByTestId("paused")).toBeVisible({ timeout: 60_000 });
    expect(await read<boolean>(leverage.address, "paused")).toBe(true);
    log.push(`PAUSE ${(await hashes(page, "pause", "crash-tx")).join(" ")}`);
  });

  await test.step("the risk-off role's borrow hits RiskIncreased", async () => {
    await runStep(page, "riskoff-refused");
    const wall = page.getByTestId("crash-step-riskoff-refused").getByTestId("crash-wall");
    await expect(wall).toHaveAttribute("data-error", "RiskIncreased");
    const [hash = ""] = await hashes(page, "riskoff-refused", "crash-wall");
    expect(await status(hash)).toBe("FAILED");
    log.push(`RISK_INCREASED ${hash}`);
  });

  await test.step("the risk-off agent repays Blend debt while paused", async () => {
    await runStep(page, "riskoff-repay");
    const [hash = ""] = await hashes(page, "riskoff-repay", "crash-tx");
    expect(await status(hash)).toBe("SUCCESS");
    log.push(`RISKOFF_REPAY ${hash}`);
  });

  await test.step("a depositor withdraws while paused", async () => {
    await runStep(page, "withdraw");
    const [hash = ""] = await hashes(page, "withdraw", "crash-tx");
    expect(await status(hash)).toBe("SUCCESS");
    expect(await read<boolean>(leverage.address, "paused")).toBe(true);
    log.push(`WITHDRAW ${hash}`);
  });

  await test.step("the price is restored and the vault runs again", async () => {
    await runStep(page, "restore");
    await expect(page.getByTestId("crash-again")).toBeVisible();
    await expect(page.getByTestId("crash-running")).toBeVisible({ timeout: 30_000 });
    expect(await forcedPrice()).toBeNull();
    expect(await read<boolean>(leverage.address, "paused")).toBe(false);
    const restore = await hashes(page, "restore", "crash-tx");
    for (const hash of restore) expect(await status(hash)).toBe("SUCCESS");
    log.push(`RESTORE ${restore.join(" ")}`);
  });

  console.log(log.join("\n"));
});
