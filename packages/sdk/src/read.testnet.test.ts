import { Address, Contract } from "@stellar/stellar-sdk";
import { describe, expect, test } from "vitest";
import { actions } from "./actions.js";
import { TESTNET } from "./network.js";
import { decodePolicy, encodePolicy } from "./policy.js";
import { fixtureKey, fixtureVault, fixtures, testLeash } from "./testnet.fixture.js";

const UNIT = 10_000_000n;
const leash = testLeash();

describe("live factory, registry and oracle", () => {
  test("the factory lists every vault it deployed, the SDK fixtures included", async () => {
    const [addresses, count] = await Promise.all([
      leash.vaultAddresses(),
      leash.read<number>(fixtures.factory as string, "vault_count"),
    ]);
    expect(addresses).toHaveLength(count);
    expect(addresses).toEqual(expect.arrayContaining([fixtureVault("sdk-smoke").address, fixtureVault("sdk-probe").address]));
  });

  test("registry policies decode and re-encode to the exact stored XDR", async () => {
    const addresses = await leash.vaultAddresses();
    let checked = 0;
    for (const address of addresses) {
      const raw = await leash.chain.read(fixtures.keeper as string,
        new Contract(fixtures.policyRegistry as string).call("policy", new Address(address).toScVal()));
      if (raw.type === "scvVoid") continue;
      expect(encodePolicy(decodePolicy(raw)).toXDR("base64"), address).toBe(raw.toXDR("base64"));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  test("oracle prices are in USDC with 7 decimals", async () => {
    const [usdc, xlm] = await Promise.all([leash.price(TESTNET.usdc), leash.price(TESTNET.xlm)]);
    expect(usdc).toBeGreaterThan(UNIT * 95n / 100n);
    expect(usdc).toBeLessThan(UNIT * 105n / 100n);
    expect(xlm).toBeGreaterThan(0n);
    expect(xlm).toBeLessThan(UNIT * 10n);
  });
});

describe("vault reads", () => {
  test("summaries name roles, creator and adapters", async () => {
    const summaries = await leash.vaults();
    const smoke = summaries.find(s => s.address === fixtureVault("sdk-smoke").address);
    expect(smoke).toMatchObject({
      name: "SDK smoke",
      creator: fixtureKey("LEASH_SDKTEST_OWNER_SECRET").publicKey(),
      agent: fixtureKey("LEASH_SDKTEST_AGENT_SECRET").publicKey(),
      paused: false,
      roles: ["default", "riskoff"],
      assets: [TESTNET.usdc, TESTNET.xlm],
    });
    expect(smoke?.adapters.map(a => a.kind)).toEqual(["Blend", "DeFindex", "Soroswap"]);
    expect(summaries.filter(s => s.nav !== null && s.nav > 0n).length).toBeGreaterThanOrEqual(3);
  });

  test("roles, usage and the daily loss of the smoke vault", async () => {
    const vault = leash.vault(fixtureVault("sdk-smoke").address);
    const [roles, usage, loss, riskUsage] = await Promise.all([vault.roles(), vault.usage(), vault.dailyLoss(), vault.usage("riskoff")]);
    expect(roles.default?.member).toBe(fixtureKey("LEASH_SDKTEST_AGENT_SECRET").publicKey());
    expect(roles.riskoff).toMatchObject({ mode: "RiskOff", member: fixtureKey("LEASH_SDKTEST_RISKOFF_SECRET").publicKey() });
    expect(usage.calls).toBeGreaterThanOrEqual(0);
    expect(loss).toBeGreaterThanOrEqual(0n);
    expect(riskUsage.spent).toBeGreaterThanOrEqual(0n);
  });

  test("positions recomputed from protocol reads add up to the on-chain NAV", async () => {
    const summaries = await leash.vaults();
    const priced = summaries.filter(s => s.nav !== null && s.nav > 0n);
    expect(priced.length).toBeGreaterThanOrEqual(3);
    for (const summary of priced) {
      const vault = leash.vault(summary.address);
      const [positions, nav] = await Promise.all([vault.positions(), vault.nav()]);
      const total = positions.reduce((sum, p) => sum + p.value, 0n);
      const gap = total > nav ? total - nav : nav - total;
      // Rounding per position (oracle conversion, Blend rates) stays below 1 bp of the NAV.
      expect(gap * 10_000n, `${summary.name} positions ${total} vs NAV ${nav}`).toBeLessThanOrEqual(nav);
    }
  });

  test("a refused call is decoded in simulation without a signature", async () => {
    const summaries = await leash.vaults();
    const demo = summaries.find(s => s.agent && s.nav !== null && s.address !== fixtureVault("sdk-smoke").address);
    if (!demo?.agent) throw new Error("No live demo vault with a session key");
    const [transfer] = actions.usdcTransfer(demo.address, demo.agent, UNIT);
    if (!transfer) throw new Error("usdcTransfer built no call");
    const result = await leash.vault(demo.address).simulateExecute(demo.agent, transfer);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ contract: "vault", code: 1, name: "CallNotAllowed" }) });
    expect(leash.decodeError(result)).toMatchObject({ name: "CallNotAllowed" });
  });
});

describe("leaderboard", () => {
  test("rows come from NavSnapshot events, best return first", async () => {
    const rows = await leash.leaderboard();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const now = Date.now() / 1000;
    for (const row of rows) {
      expect(row.snapshots.length).toBeGreaterThan(0);
      expect(row.snapshots.every(s => s.vault === row.vault && s.txHash.length === 64)).toBe(true);
      expect(row.since).toBeLessThanOrEqual(now);
      expect(row.worstDrawdownBps).toBeGreaterThanOrEqual(0);
    }
    expect(rows.map(r => r.returnBps)).toEqual([...rows.map(r => r.returnBps)].sort((a, b) => b - a));
    expect(rows.map(r => r.vault)).toContain(fixtureVault("sdk-smoke").address);
  });
});
