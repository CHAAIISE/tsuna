import { expect, test } from "@playwright/test";
import { Tsuna } from "@tsuna/sdk";
import { rpc } from "@stellar/stellar-sdk";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { z } from "zod";

const statusLabels = { pending: "Not started", running: "In progress", done: "Done", failed: "Failed" } as const;
const stepIds = ["burn", "attestation", "mint", "swap", "deposit"] as const;

interface BridgeStatus {
  job: { status: string; steps: { id: (typeof stepIds)[number]; status: keyof typeof statusLabels }[] } | null;
  bridge: { ready: boolean };
}

test("the bridge tracker renders the status served by the API", async ({ page, request }) => {
  const response = await request.get("/api/bridge");
  expect(response.ok()).toBe(true);
  const status = await response.json() as BridgeStatus;

  await page.goto("/bridge");
  await expect(page.getByRole("heading", { name: "Deposit from Ethereum" })).toBeVisible();
  const tracker = page.getByTestId("bridge-tracker");
  await expect(tracker).toHaveAttribute("data-job-status", status.job?.status ?? "none");

  // A running job may advance between the two reads; finished or absent jobs are stable.
  if (status.job?.status !== "running") {
    for (const id of stepIds) {
      const expected = status.job?.steps.find(step => step.id === id)?.status ?? "pending";
      await expect(page.getByTestId(`bridge-step-${id}`)).toHaveAttribute("data-status", expected);
      await expect(page.getByTestId(`bridge-step-${id}-status`)).toHaveText(statusLabels[expected]);
    }
  }
  const primary = page.locator("[data-primary]");
  await expect(primary).toHaveCount(1);
  if (status.job?.status === "done") await expect(primary).toHaveAttribute("href", "/agents");
});

const bridgeState = z.object({
  bridge: z.object({ ready: z.boolean(), vault: z.string(), recipient: z.string() }),
  job: z.object({
    id: z.string(),
    status: z.enum(["running", "done", "failed"]),
    error: z.string().optional(),
    steps: z.array(z.object({
      id: z.enum(stepIds),
      status: z.enum(["pending", "running", "done", "failed"]),
      txs: z.array(z.object({ hash: z.string(), network: z.enum(["sepolia", "stellar"]), label: z.string() })),
    })),
    result: z.object({ burned: z.string(), minted: z.string(), deposited: z.string(), shares: z.string() }).optional(),
  }).nullable(),
});

test("CCTP burns Sepolia USDC and deposits the minted funds into a Stellar vault", async ({ page, request }) => {
  test.setTimeout(600_000);
  await test.step("10 · bridge from Sepolia through CCTP, swap and receive vault shares", async () => {
    const initialResponse = await request.get("/api/bridge");
    expect(initialResponse.ok()).toBe(true);
    const initial = bridgeState.parse(await initialResponse.json());
    expect(initial.bridge.ready).toBe(true);
    expect(initial.job?.status, "Do not interfere with another bridge run").not.toBe("running");
    const client = new Tsuna();
    const vault = client.vault(initial.bridge.vault);
    const sharesBefore = await vault.sharesOf(initial.bridge.recipient);
    await page.goto("/bridge");
    const start = page.getByRole("button", { name: /^(Bridge and deposit|Bridge again)$/ });
    await expect(start).toBeEnabled();
    const started = page.waitForResponse(response => response.url().endsWith("/api/bridge") && response.request().method() === "POST");
    await start.click();
    const response = await started;
    expect(response.status()).toBe(202);
    const created = z.object({ job: z.object({ id: z.string() }) }).parse(await response.json());
    let final: z.infer<typeof bridgeState> | undefined;
    await expect.poll(async () => {
      const result = await request.get(`/api/bridge?id=${created.job.id}`);
      expect(result.ok()).toBe(true);
      final = bridgeState.parse(await result.json());
      if (final.job?.status === "failed") throw new Error(final.job.error ?? "Bridge failed");
      return final.job?.status;
    }, { timeout: 480_000, intervals: [3_000] }).toBe("done");
    if (!final?.job?.result) throw new Error("No completed bridge result");
    await expect(page.getByTestId("bridge-tracker")).toHaveAttribute("data-job-status", "done");
    for (const id of stepIds) await expect(page.getByTestId(`bridge-step-${id}`)).toHaveAttribute("data-status", "done");
    const result = final.job.result;
    expect(BigInt(result.burned)).toBe(1_000_000n);
    expect(BigInt(result.minted)).toBeGreaterThan(0n);
    expect(BigInt(result.deposited) * 10_000n).toBeGreaterThanOrEqual(BigInt(result.minted) * 9_950n);
    expect(BigInt(result.shares)).toBeGreaterThan(0n);
    expect(await vault.sharesOf(initial.bridge.recipient) - sharesBefore).toBe(BigInt(result.shares));
    const evm = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
    const stellar = new rpc.Server("https://soroban-testnet.stellar.org");
    await page.getByText("Details", { exact: true }).click();
    for (const step of final.job.steps) {
      expect(step.status).toBe("done");
      for (const tx of step.txs) {
        const explorer = tx.network === "sepolia" ? "https://sepolia.etherscan.io" : "https://stellar.expert/explorer/testnet";
        await expect(page.locator(`a[href="${explorer}/tx/${tx.hash}"]`)).toBeVisible();
        if (tx.network === "stellar") expect((await stellar.getTransaction(tx.hash)).status).toBe("SUCCESS");
        else {
          if (!/^0x[0-9a-f]{64}$/.test(tx.hash)) throw new Error("Invalid Sepolia transaction hash");
          expect((await evm.getTransactionReceipt({ hash: tx.hash as `0x${string}` })).status).toBe("success");
        }
        console.log(`BRIDGE_${step.id.toUpperCase()} ${tx.network} ${tx.hash}`);
      }
    }
    expect(final.job.steps.find(step => step.id === "burn")?.txs.some(tx => tx.network === "sepolia")).toBe(true);
    expect(final.job.steps.find(step => step.id === "deposit")?.txs.some(tx => tx.network === "stellar")).toBe(true);
  });
});
