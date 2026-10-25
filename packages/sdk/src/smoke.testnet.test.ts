import { env } from "node:process";
import { describe, expect, test } from "vitest";
import { actions } from "./actions.js";
import { TESTNET } from "./network.js";
import { fixtureKey, fixtureVault, testLeash } from "./testnet.fixture.js";

const UNIT = 10_000_000n;

describe("testnet write smoke", () => {
  const leash = testLeash();
  const { address } = fixtureVault("sdk-smoke");
  const vault = leash.vault(address);
  const owner = fixtureKey("LEASH_SDKTEST_OWNER_SECRET");
  const agent = fixtureKey("LEASH_SDKTEST_AGENT_SECRET");
  const attacker = env.LEASH_ATTACKER_PUBLIC ?? owner.publicKey();

  test("deposit, allowed Blend supply, on-chain refusal of a transfer, withdrawal", async () => {
    const deposited = await vault.deposit(owner, 2n * UNIT);
    expect(deposited.status).toBe("SUCCESS");
    const shares = await vault.sharesOf(owner.publicKey());
    expect(shares).toBeGreaterThan(0n);

    const [supply] = actions.blendSupply(address, TESTNET.usdc, UNIT / 2n);
    if (!supply) throw new Error("blendSupply built no call");
    const simulated = await vault.simulateExecute(agent, supply);
    expect(simulated.ok).toBe(true);
    const supplied = await vault.execute(agent, supply);
    expect(supplied.status).toBe("SUCCESS");
    const positions = await vault.positions();
    const blend = positions.find(p => p.protocol === TESTNET.blendPool && p.kind === "supply");
    expect(blend?.amount ?? 0n).toBeGreaterThan(0n);

    // The session key only signs its authorization; the owner pays as transaction source.
    const [withdrawBlend] = actions.blendWithdraw(address, TESTNET.usdc, UNIT / 10n);
    if (!withdrawBlend) throw new Error("blendWithdraw built no call");
    const sponsored = await vault.execute(agent, withdrawBlend, { feePayer: owner });
    expect(sponsored.status).toBe("SUCCESS");

    const [transfer] = actions.usdcTransfer(address, attacker, UNIT);
    if (!transfer) throw new Error("usdcTransfer built no call");
    const refused = await vault.execute(agent, transfer, { submitEvenIfRefused: true, feePayer: owner });
    expect(refused.status).toBe("FAILED");
    expect(refused.error).toMatchObject({ contract: "vault", code: 1, name: "CallNotAllowed" });
    const onChain = await leash.server.getTransaction(refused.hash);
    expect(onChain.status).toBe("FAILED");

    // Withdraw everything the owner holds now, performance-fee shares included.
    const held = await vault.sharesOf(owner.publicKey());
    const redeemed = await vault.withdraw(owner, held);
    expect(redeemed.status).toBe("SUCCESS");
    expect(await vault.sharesOf(owner.publicKey())).toBeLessThan(held);

    console.log([
      `DEPOSIT ${deposited.hash}`,
      `SUPPLY ${supplied.hash} SUCCESS`,
      `SPONSORED_WITHDRAW ${sponsored.hash} SUCCESS`,
      `REFUSED ${refused.hash} FAILED ${refused.error?.name}`,
      `WITHDRAW ${redeemed.hash}`,
    ].join("\n"));
  });
});
