import { readFileSync } from "node:fs";
import { Account, Address, Contract, Networks, TransactionBuilder, rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";

/** The runtime test vault: deposits and withdrawals never touch the demo fleet's keys. */
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

const usdc = (text: string) => Number(text.replace(/[^\d.]/g, ""));

test("the portfolio shows a fresh user's deposit and its withdraw shortcut empties it", async ({ page, context }) => {
  test.setTimeout(600_000);
  if (!target) throw new Error("No runtime test vault in deployments/agent.testnet.json");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await test.step("signed out, the portfolio asks for a passkey", async () => {
    await page.goto("/portfolio");
    await expect(page.locator("[data-primary]:visible")).toHaveText(/Sign in with passkey/);
  });

  await test.step("create a passkey account, get test USDC and deposit 25 USDC", async () => {
    await page.goto("/onboarding");
    await page.getByTestId("create-passkey").click();
    await expect(page.getByTestId("account-ready")).toBeVisible();
    await page.getByTestId("get-usdc").click();
    await expect(page.getByTestId("usdc-balance")).toContainText("1,000.00");
    await page.goto(`/agents/${target.slug}`);
    await page.getByTestId("deposit-amount").fill("25");
    await page.getByTestId("deposit-submit").click();
    await expect(page.getByTestId("action-receipt")).toBeVisible({ timeout: 180_000 });
  });
  const account = await page.evaluate(() => (JSON.parse(localStorage.getItem("leash.passkey-account") ?? "{}") as { account?: string }).account ?? "");
  const shares = await read<bigint>(target.address, "balance", new Address(account).toScVal());
  expect(shares).toBeGreaterThan(0n);

  await test.step("the portfolio lists the deposit with its on-chain value", async () => {
    await page.goto("/portfolio");
    await expect(page.getByTestId("portfolio-account")).toHaveAttribute("title", account);
    const row = page.locator(`[data-testid="holding-row"][data-vault="${target.address}"]`);
    await expect(row).toBeVisible();
    // 25 USDC in, valued at the share price (rounding and accrued interest within a cent).
    expect(Math.abs(usdc(await row.getByTestId("holding-value").innerText()) - 25)).toBeLessThan(0.02);
    await expect(page.getByTestId("portfolio-wallet")).toContainText("975.00");
    await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
  });

  await test.step("the withdraw shortcut redeems every share", async () => {
    await page.locator(`[data-testid="holding-row"][data-vault="${target.address}"]`).getByTestId("withdraw-shortcut").click();
    await expect(page.getByRole("tab", { name: "Withdraw" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: /Position .* Max/ }).click();
    await page.getByTestId("withdraw-submit").click();
    await expect(page.getByTestId("action-receipt")).toBeVisible({ timeout: 180_000 });
  });
  const withdrawHash = await page.getByTestId("action-hash").getAttribute("data-hash") ?? "";
  expect((await retry(() => server.getTransaction(withdrawHash))).status).toBe("SUCCESS");
  expect(await read<bigint>(target.address, "balance", new Address(account).toScVal())).toBe(0n);

  console.log(`PORTFOLIO_USER ${account}\nPORTFOLIO_SHARES ${shares}\nWITHDRAW_TX ${withdrawHash}`);
});
