import { readFileSync } from "node:fs";
import { Account, Address, Contract, Networks, TransactionBuilder, rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";

/**
 * Runs on the runtime test vault (`deployments/agent.testnet.json`): it has
 * keys of its own, so this test never shares a sequence number with the demo
 * fleet's session key.
 */
const target = (JSON.parse(readFileSync(new URL("../../deployments/agent.testnet.json", import.meta.url), "utf8")) as {
  vaults: { slug: string; address: string }[];
}).vaults[0];
const passkey = JSON.parse(readFileSync(new URL("../../deployments/passkey.testnet.json", import.meta.url), "utf8")) as { relayer: string };
const server = new rpc.Server("https://soroban-testnet.stellar.org");

/** The public testnet RPC answers 502 now and then: retry a read a few times. */
async function retry<T>(task: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 2_000));
    }
  }
}

async function read<T>(contract: string, fn: string, ...args: xdr.ScVal[]): Promise<T> {
  const tx = new TransactionBuilder(new Account(passkey.relayer, "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const simulation = await retry(() => server.simulateTransaction(tx));
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) throw new Error(`${fn} simulation failed`);
  return scValToNative(simulation.result.retval) as T;
}

async function status(hash: string): Promise<string> {
  return (await retry(() => server.getTransaction(hash))).status;
}

test("a passkey user deposits 1,000 USDC, then the agent's next call is authorized on-chain", async ({ page, context }) => {
  test.setTimeout(600_000);
  if (!target) throw new Error("No runtime test vault in deployments/agent.testnet.json");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await test.step("03 · create a passkey account and get test USDC", async () => {
    await page.goto("/onboarding");
    await page.getByTestId("create-passkey").click();
    await expect(page.getByTestId("account-ready")).toBeVisible();
    await page.getByTestId("get-usdc").click();
    await expect(page.getByTestId("usdc-balance")).toContainText("1,000.00");
  });
  const account = (await page.getByTestId("account-address").textContent())?.trim() ?? "";
  expect(account).toMatch(/^C[A-Z2-7]{55}$/);

  let emptyRunReads = 0;
  await page.route("**/api/agent?*", route => {
    emptyRunReads++;
    return route.fulfill({ json: { run: null } });
  });
  await test.step("04 · deposit 1,000 USDC into Prudent and receive shares", async () => {
    await page.goto(`/agents/${target.slug}`);
    await expect(page.getByTestId("kpi-tvl")).not.toHaveText("—");
    await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
    await page.getByTestId("deposit-amount").fill("1000");
    await page.getByTestId("deposit-submit").click();
    await expect(page.getByTestId("action-receipt")).toBeVisible({ timeout: 180_000 });
  });
  const depositHash = await page.getByTestId("action-hash").getAttribute("data-hash") ?? "";
  expect(await status(depositHash)).toBe("SUCCESS");
  const shares = await read<bigint>(target.address, "balance", new Address(account).toScVal());
  expect(shares).toBeGreaterThan(0n);
  await expect(page.getByTestId("your-position")).not.toHaveText("0.00 USDC");

  // Authorized calls already in the history (from earlier runs) do not count.
  const before = new Set(await page.locator('[data-testid="timeline-action"][data-hash]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-hash"))));
  let agentHash = "";
  // Another serverless instance can have no run and a stale activity snapshot.
  const activity = await page.request.get(`/api/vaults/${target.slug}/activity?fresh=1`);
  expect(activity.ok()).toBe(true);
  const staleActivity: unknown = await activity.json();
  await page.route(`**/api/vaults/${target.slug}/activity*`, route => route.fulfill({ json: staleActivity }));
  await test.step("05 · run the agent until a new call is authorized on-chain", async () => {
    await page.getByTestId("run-agent").click();
    await expect(page.getByTestId("run-agent")).toHaveText(/Agent is working/);
    const authorized = page.locator('[data-testid="timeline-action"][data-outcome="authorized"][data-source="run"]');
    await expect.poll(async () => {
      const hashes = await authorized.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-hash") ?? ""));
      agentHash = hashes.find(hash => hash && !before.has(hash)) ?? "";
      return agentHash;
    }, { timeout: 360_000, intervals: [2_000] }).toMatch(/^[0-9a-f]{64}$/);
  });
  const link = page.locator(`[data-testid="timeline-action"][data-hash="${agentHash}"]`).getByTestId("tx-link");
  await expect(link).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${agentHash}`);
  expect(await status(agentHash)).toBe("SUCCESS");
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByTestId("agent-journal")).toContainText("Agent run finished");
  await expect(page.getByTestId("agent-journal")).not.toContainText("Agent run in progress");
  expect(emptyRunReads).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "../.hack/design/self/vault-run-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "../.hack/design/self/vault-run-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  console.log(`VAULT_USER ${account}\nDEPOSIT_TX ${depositHash}\nSHARES ${shares}\nAGENT_TX ${agentHash}`);
});
