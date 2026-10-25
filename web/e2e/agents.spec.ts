import { existsSync, readFileSync } from "node:fs";
import { Account, Contract, Keypair, Networks, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { Leash, parseDeployments } from "@leash/sdk";
import { expect, test } from "@playwright/test";

const deployment = <T>(file: string) => JSON.parse(readFileSync(new URL(`../../deployments/${file}`, import.meta.url), "utf8")) as T;
const fleet = deployment<{ keeper: string; vaults: { id: string; name: string; address: string }[] }>("testnet.json");
const server = new rpc.Server("https://soroban-testnet.stellar.org");

const envFile = new URL("../../.env.local", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Vaults deployed by the SDK, runtime, bridge and fleet rehearsals: never on the leaderboard. */
const testVaults = [
  ...deployment<{ vaults: { address: string }[] }>("agent.testnet.json").vaults.map(vault => vault.address),
  ...deployment<{ vaults: { address: string }[] }>("sdk.testnet.json").vaults.map(vault => vault.address),
  ...deployment<{ fleets: { test: { vaults: { address: string }[] } } }>("fleet.testnet.json").fleets.test.vaults.map(vault => vault.address),
  deployment<{ vault: string }>("cctp.testnet.json").vault,
];

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

test("only the demo agents and agents published with Create are listed and counted", async ({ page }) => {
  // Every vault on the demo factory, with the creator its registry records.
  const onFactory = await new Leash({ deployments: parseDeployments(deployment("testnet.json")) }).vaults();
  const secret = process.env.LEASH_CREATOR_SECRET;
  const publisher = secret ? Keypair.fromSecret(secret).publicKey() : null;
  const demo = new Set(fleet.vaults.map(vault => vault.address));
  const published = onFactory.filter(vault => !demo.has(vault.address) && vault.creator === publisher).map(vault => vault.address);
  expect(onFactory.some(vault => testVaults.includes(vault.address)), "test vaults share the demo factory").toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents");
  await expect(page.getByRole("region", { name: "Featured agents" }).getByTestId("agent-row")).toHaveCount(3);
  const listed = await page.getByTestId("agent-row").evaluateAll(rows => rows.map(row => row.getAttribute("data-vault") ?? ""));
  expect([...listed].sort()).toEqual([...demo, ...published].sort());
  for (const vault of testVaults) expect(listed).not.toContain(vault);

  const community = page.getByRole("region", { name: "Community agents" });
  if (published.length === 0) await expect(community.getByTestId("community-empty")).toBeVisible();
  else await expect(community.getByTestId("agent-row")).toHaveCount(published.length);

  await expect(page.getByTestId("agents-count")).toHaveText(String(listed.length));
  const navs = await Promise.all(listed.map(onChainNav));
  const expected = Number(navs.reduce((sum, nav) => sum + nav, 0n)) / 1e7;
  // Blend interest accrues between the reads: a few cents of tolerance across the vaults.
  expect(Math.abs(usdc(await page.getByTestId("total-in-vaults").innerText()) - expected)).toBeLessThan(0.05);
});
