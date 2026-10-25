import { readFileSync } from "node:fs";
import { Account, Address, Contract, Networks, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";

const deployment = JSON.parse(readFileSync(new URL("../../deployments/passkey.testnet.json", import.meta.url), "utf8")) as {
  relayer: string;
  usdc: string;
};
const server = new rpc.Server("https://soroban-testnet.stellar.org");

/** Reads the USDC balance straight from the chain, independently of the app. */
async function onChainBalance(owner: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(deployment.relayer, "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(deployment.usdc).call("balance", new Address(owner).toScVal()))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) throw new Error("Balance simulation failed");
  return scValToNative(simulation.result.retval) as bigint;
}

async function expectSuccessful(hash: string): Promise<void> {
  const result = await server.getTransaction(hash);
  expect(result.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
}

test("a passkey creates a gasless smart account and receives test USDC", async ({ page, context }) => {
  // Chromium's virtual authenticator runs the real WebAuthn ceremony headless.
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await page.goto("/onboarding");
  const steps = page.getByTestId("onboarding-steps");
  await expect(steps).toBeVisible();
  await expect(steps.locator('[aria-current="step"]')).toContainText("Create your passkey");
  await expect(page.locator("[data-primary]")).toHaveCount(1);

  await page.getByTestId("create-passkey").click();
  await expect(page.getByTestId("account-ready")).toBeVisible();
  await expect(steps.locator('[aria-current="step"]')).toContainText("Get test USDC");
  const account = (await page.getByTestId("account-address").textContent())?.trim() ?? "";
  const deployHash = (await page.getByTestId("deploy-hash").textContent())?.trim() ?? "";
  expect(account).toMatch(/^C[A-Z2-7]{55}$/);
  await expectSuccessful(deployHash);
  expect(await onChainBalance(account)).toBe(0n);

  await page.getByTestId("get-usdc").click();
  await expect(page.getByTestId("usdc-balance")).toContainText("1,000.00");
  await expect(steps.locator('[aria-current="step"]')).toContainText("Pick an agent and deposit");
  await expect(page.locator("[data-primary]")).toHaveCount(1);
  const faucetHash = (await page.getByTestId("faucet-hash").textContent())?.trim() ?? "";
  await expectSuccessful(faucetHash);
  expect(await onChainBalance(account)).toBe(10_000_000_000n);

  test.info().annotations.push(
    { type: "smart-account", description: account },
    { type: "deploy-tx", description: deployHash },
    { type: "faucet-tx", description: faucetHash },
  );
  console.log(`SMART_ACCOUNT ${account}\nDEPLOY_TX ${deployHash}\nFAUCET_TX ${faucetHash}`);
});
