import { existsSync, readFileSync } from "node:fs";
import { Address, Contract, Keypair, Transaction, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { Leash, actions } from "@leash/sdk";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const envFile = new URL("../../.env.local", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const runtime = z.object({
  vaults: z.array(z.object({ slug: z.string(), address: z.string(), agent: z.string(), assets: z.array(z.string()) })),
}).parse(JSON.parse(readFileSync(new URL("../../deployments/agent.testnet.json", import.meta.url), "utf8")));
const target = runtime.vaults[0];

function key(name: string): Keypair {
  const secret = process.env[name];
  if (!secret) throw new Error(`Missing ${name}`);
  return Keypair.fromSecret(secret);
}

test("the creator revokes a stolen session without closing withdrawals", async ({ page, request }) => {
  test.setTimeout(360_000);
  const asset = target?.assets[0];
  if (!target || !asset) throw new Error("No runtime test vault or base asset");
  const client = new Leash();
  const vault = client.vault(target.address);
  const owner = key("LEASH_AGENTRUN_OWNER_SECRET");
  const member = key("LEASH_AGENTRUN_AGENT_SECRET");
  const fee = key("LEASH_AGENTRUN_FEE_SECRET");
  expect(await vault.owner()).toBe(owner.publicKey());
  expect(await vault.session()).toBe(member.publicKey());
  const [call] = actions.blendSupply(target.address, asset, 1n);
  if (!call) throw new Error("No Blend supply call");
  const sharesBefore = await vault.totalShares();
  const ownerShares = await vault.sharesOf(owner.publicKey());
  expect(ownerShares).toBeGreaterThan(100n);
  const ownerAddress = new Address(owner.publicKey()).toScVal();
  let returned = 0n;
  let revoked = false;
  try {
    await test.step("07 · revoke the stolen session and reject its next signed call", async () => {
      const prepared = await request.post("/api/attack", { data: {
        action: "prepare-revoke", vault: target.slug, account: owner.publicKey(),
      } });
      expect(prepared.ok()).toBe(true);
      const envelope = z.object({ xdr: z.string() }).parse(await prepared.json());
      const transaction = TransactionBuilder.fromXDR(envelope.xdr, client.networkPassphrase);
      if (!(transaction instanceof Transaction)) throw new Error("Expected an ordinary revoke transaction");
      // A dedicated creator burner signs the same envelope a wallet extension would sign.
      const receipt = await client.chain.submit(owner, transaction, "vault");
      expect(receipt.status).toBe("SUCCESS");
      revoked = true;
      expect((await client.server.getTransaction(receipt.hash)).status).toBe("SUCCESS");
      expect(await vault.session()).toBeNull();
      const refusal = await vault.execute(member, call, { feePayer: fee, submitEvenIfRefused: true });
      expect(refusal.status).toBe("FAILED");
      expect(refusal.error?.name).toBe("SessionRevoked");
      expect((await client.server.getTransaction(refusal.hash)).status).toBe("FAILED");
      await page.goto(`/agents/${target.slug}/attack`);
      await expect(page.getByTestId("session-state")).toContainText("revoked");
      await expect(page.getByRole("button", { name: "Revoke session key" })).toBeDisabled();
      await page.goto(`/agents/${target.slug}`);
      await page.getByRole("tab", { name: "Withdraw", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Withdraw", exact: true })).toHaveAttribute("aria-selected", "true");
      expect(await vault.totalShares()).toBe(sharesBefore);
      const before = await client.read<bigint>(asset, "balance", [ownerAddress]);
      const withdrawal = await vault.withdraw(owner, ownerShares / 100n);
      returned = await client.read<bigint>(asset, "balance", [ownerAddress]) - before;
      expect(withdrawal.status).toBe("SUCCESS");
      expect((await client.server.getTransaction(withdrawal.hash)).status).toBe("SUCCESS");
      expect(returned).toBeGreaterThan(0n);
      expect(await vault.session()).toBeNull();
      console.log(`WITHDRAW_REVOKED ${withdrawal.hash}`);
      console.log(`SESSION_REVOKED ${receipt.hash}\nREVOKED_CALL ${refusal.hash}`);
    });
  } finally {
    if (revoked) {
      const restored = await client.chain.invoke(fee, new Contract(target.address).call("rotate_session", new Address(member.publicKey()).toScVal()), [owner], "vault");
      expect(restored.status).toBe("SUCCESS");
      expect(await vault.session()).toBe(member.publicKey());
      console.log(`SESSION_RESTORED ${restored.hash}`);
    }
    if (returned > 0n) {
      const redeposit = await vault.deposit(owner, returned);
      expect(redeposit.status).toBe("SUCCESS");
      console.log(`WITHDRAWAL_REDEPOSITED ${redeposit.hash}`);
    }
  }
  // A restored key can pass authorization again; the call is simulated, not submitted.
  const simulated = await vault.simulateExecute(member, { target: asset, fn: "transfer", args: [
    new Address(target.address).toScVal(), new Address(owner.publicKey()).toScVal(), nativeToScVal(1n, { type: "i128" }),
  ] });
  expect(simulated.ok).toBe(false);
  if (!simulated.ok) expect(simulated.error.name).toBe("CallNotAllowed");
});
