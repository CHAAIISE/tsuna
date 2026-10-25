import { readFileSync } from "node:fs";
import { Account, Contract, Networks, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";

const fleet = JSON.parse(readFileSync(new URL("../../deployments/testnet.json", import.meta.url), "utf8")) as {
  keeper: string;
  vaults: { id: string; name: string; address: string }[];
};
const server = new rpc.Server("https://soroban-testnet.stellar.org");

/** NAV read straight from the vault contract, independently of the app (base units). */
async function onChainNav(vault: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(fleet.keeper, "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(vault).call("nav"))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) throw new Error(`nav() simulation failed for ${vault}`);
  return scValToNative(simulation.result.retval) as bigint;
}

const usdc = (text: string) => Number(text.replace(/[^\d.]/g, ""));

test("the leaderboard lists the three demo agents with values read on-chain", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  const featured = page.getByRole("region", { name: "Featured agents" }).getByTestId("agent-row");
  await expect(featured).toHaveCount(3);
  await expect(page.locator("[data-primary]:visible")).toHaveCount(1);

  for (const vault of fleet.vaults) {
    const row = page.locator(`[data-testid="agent-row"][data-vault="${vault.address}"]`);
    await expect(row).toContainText(vault.name);
    await expect(row.getByText(/rules$/)).toBeVisible();
    const shown = usdc(await row.getByTestId("agent-tvl").innerText());
    const nav = Number(await onChainNav(vault.address)) / 1e7;
    // Blend interest accrues between the two reads: a cent of tolerance.
    expect(Math.abs(shown - nav)).toBeLessThan(0.02);
  }

  const total = usdc(await page.getByTestId("total-in-vaults").innerText());
  expect(total).toBeGreaterThan(0);

  await page.locator(`[data-testid="agent-row"][data-vault="${fleet.vaults[0]?.address}"]`).getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/agents/${fleet.vaults[0]?.id}$`));
});
