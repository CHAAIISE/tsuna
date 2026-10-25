import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, test } from "vitest";
import { actions } from "./actions.js";
import { LeashRefusal } from "./errors.js";
import { TESTNET } from "./network.js";
import { DEFAULT_LIMITS, decodePolicy, encodePolicy, type Policy, type PolicyCall } from "./policy.js";
import {
  MAX_LOSS_BPS, RISK_OFF_QUOTA, RISK_OFF_ROLE, composePolicy, presetOf, presets,
  type CallPreset, type CallPresetId, type Venues,
} from "./presets.js";
import { fixtureKey, fixtureVault, fixtures, testLeash } from "./testnet.fixture.js";

const protocols = fixtures.protocols ?? {};
const venues: Venues = {
  blendPool: protocols.blendPool ?? TESTNET.blendPool,
  soroswapRouter: protocols.soroswapRouter ?? TESTNET.soroswapRouter,
  ...(protocols.defindexVault ? { defindexVault: protocols.defindexVault } : {}),
  defindexCustody: [protocols.defindexBlendUsdcStrategy ?? TESTNET.defindexBlendUsdcStrategy, protocols.blendPool ?? TESTNET.blendPool],
  ...(protocols.soroswapPairXlmUsdc ? { soroswapPairs: [protocols.soroswapPairXlmUsdc] } : {}),
  ...(protocols.aquariusPoolXlmUsdc ? { aquariusPool: protocols.aquariusPoolXlmUsdc } : {}),
};
const callPresets = Object.entries(presets)
  .filter((entry): entry is [CallPresetId, CallPreset] => entry[1].kind === "call");
const ASSETS = [TESTNET.usdc, TESTNET.xlm];
const byCall = (a: PolicyCall, b: PolicyCall) => `${a.target}${a.fn}`.localeCompare(`${b.target}${b.fn}`);
const normalized = (policy: Policy): Policy => ({ ...policy, calls: [...policy.calls].sort(byCall) });

describe("presets", () => {
  test("every call preset grants one rule with its tolerance class", () => {
    for (const [id, preset] of callPresets) {
      const grant = preset.grant(venues);
      const [call] = grant.calls;
      expect(grant.calls, id).toHaveLength(1);
      expect(call?.fn).toBe(preset.fn);
      expect(call?.rule.args).toEqual(preset.args);
      expect(call?.rule.max_loss_bps).toBe(preset.volatile ? MAX_LOSS_BPS.volatile : MAX_LOSS_BPS.stable);
      expect(grant.protocols).toEqual([call?.target]);
      expect(preset.grant(venues, { volatile: false }).calls[0]?.rule.max_loss_bps).toBe(10);
      expect(preset.grant(venues, { volatile: true }).calls[0]?.rule.max_loss_bps).toBe(50);
      expect(presetOf(call as PolicyCall)?.fn).toBe(preset.fn);
    }
  });

  test("Soroswap routes are restricted to the vault's assets and pay the vault", () => {
    const [swap] = presets["soroswap.swap"].grant(venues).calls;
    expect(swap?.rule.args).toEqual(["Any", "Any", "Assets", "Vault", "Any"]);
    expect(swap?.rule.max_loss_bps).toBe(50);
  });

  test("Blend actions share one rule that keeps the loosest tolerance", () => {
    const policy = composePolicy({ assets: ASSETS, venues, actions: ["blend.supply", "blend.borrow", "blend.repay"] });
    expect(policy.calls).toEqual([{
      target: venues.blendPool, fn: "submit_with_allowance",
      rule: { approve: true, args: ["Vault", "Vault", "Vault", "BlendRequests"], max_loss_bps: 50 },
    }]);
    expect(policy.protocols).toEqual([venues.blendPool]);
  });

  test("a full policy carries guards, limits and a risk-off role", () => {
    const member = "GCNAX2DH52MFMP35OTEPRZDOFZVR5XTGLTOE34UTLLL4HMXJWT3TJPQ3";
    const policy = composePolicy({
      assets: ASSETS, venues,
      actions: callPresets.map(([id]) => id),
      limits: { min_health_factor_bps: 15_000 },
      exposureCaps: { [TESTNET.blendPool]: 6_000 },
      riskOffMember: member,
    });
    expect(policy.limits).toEqual({ ...DEFAULT_LIMITS, min_health_factor_bps: 15_000 });
    expect(policy.guards[venues.defindexVault as string]).toEqual(venues.defindexCustody);
    expect(policy.guards[venues.soroswapRouter as string]).toEqual(venues.soroswapPairs);
    const role = policy.roles?.[RISK_OFF_ROLE];
    expect(role).toMatchObject({ member, mode: "RiskOff", quota: RISK_OFF_QUOTA });
    expect(role?.calls.map(call => call.fn).sort()).toEqual(["submit_with_allowance", "withdraw"]);
    expect(normalized(decodePolicy(encodePolicy(policy)))).toEqual(normalized(policy));
  });

  test("encoded policies follow the host's map order", () => {
    const policy = composePolicy({ assets: ASSETS, venues, actions: callPresets.map(([id]) => id), riskOffMember: TESTNET.usdcIssuer });
    const encoded = encodePolicy(policy);
    if (encoded.type !== "scvMap" || !encoded.value) throw new Error("PolicyV2 must be a map");
    expect(encoded.value.map(entry => String(entry.key.value))).toEqual(
      ["assets", "calls", "exposure_caps", "guards", "limits", "protocols", "roles"]);
    const calls = encoded.value[1]?.val;
    if (calls?.type !== "scvMap" || !calls.value) throw new Error("calls must be a map");
    const keys = calls.value.map(entry => {
      if (entry.key.type !== "scvVec" || !entry.key.value) throw new Error("call keys are (address, fn)");
      const [target, fn] = entry.key.value as [xdr.ScVal, xdr.ScVal];
      return [Address.fromScVal(target).toScAddress().toXDR("hex"), String(fn.value)] as const;
    });
    const sorted = [...keys].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    expect(keys).toEqual(sorted);
  });
});

describe("presets against the deployed registry", () => {
  const leash = testLeash();
  const registry = fixtures.policyRegistry as string;
  const probe = fixtureVault("sdk-probe").address;
  const register = (policy: Policy) =>
    leash.read<null>(registry, "register", [new Address(probe).toScVal(), encodePolicy(policy)]);

  test.each(callPresets)("%s alone is a policy the registry accepts", async id => {
    await expect(register(composePolicy({ assets: ASSETS, venues, actions: [id] }))).resolves.toBeNull();
  });

  test("the risk-off role preset is accepted", async () => {
    const policy = composePolicy({
      assets: ASSETS, venues, actions: ["blend.supply", "defindex.deposit"], riskOffMember: fixtureKey("LEASH_SDKTEST_RISKOFF_SECRET").publicKey(),
    });
    await expect(register(policy)).resolves.toBeNull();
  });

  test("the registry still refuses an invalid policy (base asset not first)", async () => {
    const refused = await register(composePolicy({ assets: [TESTNET.xlm, TESTNET.usdc], venues, actions: ["blend.supply"] }))
      .then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(LeashRefusal);
    if (!(refused instanceof LeashRefusal)) throw new Error("Expected a registry refusal");
    expect(refused.error).toMatchObject({ contract: "registry", name: "InvalidPolicy" });
  });

  test("the preset policy registered on the smoke vault reads back unchanged", async () => {
    const vault = leash.vault(fixtureVault("sdk-smoke").address);
    const expected = composePolicy({
      assets: ASSETS, venues,
      actions: ["blend.supply", "blend.withdraw", "defindex.deposit", "defindex.withdraw", "soroswap.swap"],
      riskOffMember: fixtureKey("LEASH_SDKTEST_RISKOFF_SECRET").publicKey(),
    });
    expect(normalized(await vault.policy())).toEqual(normalized(expected));
  });

  test("the Soroswap preset refuses a route through an asset outside the vault's list", async () => {
    const { address } = fixtureVault("sdk-smoke");
    const vault = leash.vault(address);
    const agent = fixtureKey("LEASH_SDKTEST_AGENT_SECRET").publicKey();
    const [swap] = actions.soroswapSwap(address, [TESTNET.usdc, TESTNET.wbtc], 1_000n, 0n, venues.soroswapRouter);
    if (!swap) throw new Error("soroswapSwap built no call");
    const result = await vault.simulateExecute(agent, swap);
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ contract: "vault", code: 19, name: "AssetNotAllowed" }) });
  });
});
