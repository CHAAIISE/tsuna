/**
 * Test fleet for rehearsing a fleet upgrade without touching the demo vaults: a separate
 * `vault_factory` (two fresh admins, 2-of-2, short timelock) serving the vault build already
 * uploaded for the demo fleet, two vaults registered from a v1-shaped and from a v2 policy, and an
 * `agent_vault` build from the same source that only adds a `leash_build` contract meta entry.
 * Everything is recorded in `deployments/fleet.testnet.json`; reruns reuse what exists.
 *
 * Keys (`.env.local`): LEASH_FLEET_FEE_SECRET (source and fee payer of every transaction),
 * LEASH_FLEETTEST_ADMIN_A_SECRET / LEASH_FLEETTEST_ADMIN_B_SECRET (factory admins, sign
 * authorizations only), LEASH_FLEETTEST_CREATOR_SECRET (owner of the test vaults).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, Operation, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { contractExists, ensureAccount, ensureWasm } from "./lib/pay.js";
import {
  address, call, callRule, defaultLimits, fail, policy, read, send, sendCosigned, signer, testnet, u64,
} from "./lib/stellar.js";
import { readTestnet } from "./lib/testnet-deployment.js";

const FLEET_FILE = fileURLToPath(new URL("../deployments/fleet.testnet.json", import.meta.url));
const PATCH_DIR = fileURLToPath(new URL("../contracts/target/fleet-patch", import.meta.url));
const VAULT_TAG = "vault-v1";
/** Short on purpose: the test fleet exists to rehearse propose → wait → apply. */
const TEST_TIMELOCK_SECS = 120;
const PATCH_BUILD = "2";

interface FleetBuild {
  hash: string;
  title: string;
  description: string;
  uploadTx?: string;
}

interface FleetVault {
  address: string;
  name: string;
  /** Shape of the policy argument passed to `register`. */
  policyShape: "v1" | "v2";
  deployTx: string;
  registerTx: string;
}

interface FleetFile {
  network: "testnet";
  tag: string;
  /** Uploaded vault builds a fleet may be moved to; the label shown for each hash. */
  builds: FleetBuild[];
  fleets: {
    demo: { label: string; adminSecrets: [string, string] };
    test?: {
      label: string;
      factory: string;
      timelockSecs: number;
      adminSecrets: [string, string];
      creator: string;
      vaults: FleetVault[];
      transactions: Record<string, string>;
    };
  };
}

const fee = signer("LEASH_FLEET_FEE_SECRET");
const adminA = signer("LEASH_FLEETTEST_ADMIN_A_SECRET");
const adminB = signer("LEASH_FLEETTEST_ADMIN_B_SECRET");
const creator = signer("LEASH_FLEETTEST_CREATOR_SECRET");

function readFleet(initialBuild: string): FleetFile {
  if (existsSync(FLEET_FILE)) return JSON.parse(readFileSync(FLEET_FILE, "utf8")) as FleetFile;
  return {
    network: "testnet",
    tag: VAULT_TAG,
    builds: [{
      hash: initialBuild,
      title: "Initial vault build",
      description: "agent_vault as deployed with the demo fleet.",
    }],
    fleets: { demo: { label: "Demo fleet", adminSecrets: ["LEASH_ADMIN_SECRET", "LEASH_KEEPER_SECRET"] } },
  };
}

const save = (fleet: FleetFile) => writeFileSync(FLEET_FILE, `${JSON.stringify(fleet, null, 2)}\n`);

/** Same Blend supply/withdraw rule as the demo vaults; v1 leaves out the fields PolicyV2 added. */
function testPolicy(shape: "v1" | "v2", riskOffMember: string): xdr.ScVal {
  const blend = { target: testnet.pool, fn: "submit_with_allowance", rule: callRule(["Vault", "Vault", "Vault", "BlendRequests"], 10, true) };
  if (shape === "v2") {
    return policy([testnet.usdc], [blend], [testnet.pool], defaultLimits, {
      exposureCaps: { [testnet.pool]: 6_000 },
      roles: {
        riskoff: {
          member: riskOffMember, mode: "RiskOff", calls: [blend],
          quota: { tx_cap_bps: 2_500, daily_cap_bps: 10_000, calls_per_hour: 6, daily_loss_bps: 50 },
        },
      },
    });
  }
  const v2 = policy([testnet.usdc], [blend], [testnet.pool], defaultLimits);
  if (v2.type !== "scvMap") throw new Error("Expected a policy map");
  // A PolicyV1 map has no `exposure_caps` / `roles` keys at all (CAP-86 reads them as None).
  return xdr.ScVal.scvMap((v2.map ?? []).filter(entry => entry.val.type !== "scvVoid"));
}

async function main(): Promise<void> {
  const demo = readTestnet();
  const { vaultRef, policyRegistry, oracleRouter, keeper, agent } = demo;
  const factoryWasm = demo.wasm?.vaultFactory;
  const riskOffMember = demo.vaults.find(vault => vault.riskoffMember)?.riskoffMember;
  if (!vaultRef || !factoryWasm || !policyRegistry || !oracleRouter || !keeper || !agent || !riskOffMember) {
    throw new Error("deployments/testnet.json lacks the demo fleet; run scripts/deploy.ts and scripts/seed.ts first");
  }
  await Promise.all([ensureAccount(fee), ensureAccount(adminA), ensureAccount(adminB), ensureAccount(creator)]);
  const fleet = readFleet(vaultRef);

  let test = fleet.fleets.test;
  if (!test || !await contractExists(test.factory)) {
    const deployed = await send(fee, Operation.createCustomContract({
      address: new Address(fee.publicKey()),
      wasmHash: Buffer.from(factoryWasm, "hex"),
      constructorArgs: [address(adminA.publicKey()), address(adminB.publicKey()), u64(BigInt(TEST_TIMELOCK_SECS))],
    }));
    if (!deployed.returnValue) throw new Error("Factory deployment returned no address");
    test = {
      label: "Test fleet",
      factory: scValToNative(deployed.returnValue) as string,
      timelockSecs: TEST_TIMELOCK_SECS,
      adminSecrets: ["LEASH_FLEETTEST_ADMIN_A_SECRET", "LEASH_FLEETTEST_ADMIN_B_SECRET"],
      creator: creator.publicKey(),
      vaults: [],
      transactions: { factoryDeploy: deployed.txHash },
    };
    fleet.fleets.test = test;
    save(fleet);
    console.log(`TEST_FACTORY ${test.factory} ${deployed.txHash}`);
  }
  const { factory } = test;

  const tag = nativeToScVal(VAULT_TAG, { type: "string" });
  if (!await read<Uint8Array | null>(fee, factory, "current_ref", [tag])) {
    const set = await sendCosigned(fee, call(factory, "set_ref", [tag, xdr.ScVal.scvBytes(Buffer.from(vaultRef, "hex"))]), [adminA, adminB]);
    test.transactions.setRef = set.txHash;
    save(fleet);
    console.log(`SET_REF ${VAULT_TAG} ${vaultRef} ${set.txHash}`);
  }

  for (const shape of ["v1", "v2"] as const) {
    if (test.vaults.some(vault => vault.policyShape === shape)) continue;
    const params = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("asset"), val: address(testnet.usdc) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("oracle"), val: address(oracleRouter) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("protocol_recipient"), val: address(keeper) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("registry"), val: address(policyRegistry) }),
    ]);
    const deployed = await sendCosigned(fee, call(factory, "deploy_vault", [address(creator.publicKey()), address(agent), params]), [creator]);
    if (!deployed.returnValue) throw new Error("deploy_vault returned no address");
    const vault = scValToNative(deployed.returnValue) as string;
    const registered = await sendCosigned(fee, call(policyRegistry, "register", [address(vault), testPolicy(shape, riskOffMember)]), [creator]);
    test.vaults.push({
      address: vault,
      name: shape === "v1" ? "Test vault A" : "Test vault B",
      policyShape: shape,
      deployTx: deployed.txHash,
      registerTx: registered.txHash,
    });
    save(fleet);
    console.log(`TEST_VAULT ${shape} ${vault} deploy=${deployed.txHash} register=${registered.txHash}`);
  }

  // Same source, separate target directory so the release build used by deploy.ts stays untouched.
  execFileSync("stellar", [
    "contract", "build", "--manifest-path", "contracts/Cargo.toml", "--package", "agent-vault",
    "--meta", `leash_build=${PATCH_BUILD}`, "--out-dir", `${PATCH_DIR}/out`,
  ], { stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: PATCH_DIR } });
  const patchFile = `${PATCH_DIR}/out/agent_vault.wasm`;
  const patchHash = createHash("sha256").update(readFileSync(patchFile)).digest("hex");
  if (patchHash === vaultRef) throw new Error("The meta build has the same hash as the initial build");
  await ensureWasm(fee, patchFile);
  if (!fleet.builds.some(build => build.hash === patchHash)) {
    fleet.builds.push({
      hash: patchHash,
      title: `Rehearsal build ${PATCH_BUILD}`,
      description: `Same agent_vault source with the contract meta entry leash_build=${PATCH_BUILD}: no behaviour change, used to rehearse an upgrade on the test fleet.`,
    });
    save(fleet);
  }
  console.log(`PATCH_BUILD ${patchHash}`);
  console.log(`TEST_FLEET ${factory} vaults=${test.vaults.map(vault => vault.address).join(",")}`);
}

main().catch(fail);
