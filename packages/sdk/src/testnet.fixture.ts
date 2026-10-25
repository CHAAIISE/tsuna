/**
 * Testnet fixtures shared by the `*.testnet.test.ts` suites: the burner keys and vaults created
 * by `pnpm --filter @leash/sdk testnet:setup`, recorded in `deployments/sdk.testnet.json`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { loadDeployments, type VaultRecord } from "./deployments.js";
import { Leash } from "./leash.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const envFile = join(root, ".env.local");
if (existsSync(envFile)) loadEnvFile(envFile);

const SETUP = "run `pnpm --filter @leash/sdk testnet:setup` first";

export const fixtures = loadDeployments(join(root, "deployments", "sdk.testnet.json"));

export function fixtureVault(id: "sdk-smoke" | "sdk-probe"): VaultRecord {
  const vault = fixtures.vaults.find(v => v.id === id);
  if (!vault) throw new Error(`Missing ${id} in deployments/sdk.testnet.json: ${SETUP}`);
  return vault;
}

export function fixtureKey(name: "LEASH_SDKTEST_OWNER_SECRET" | "LEASH_SDKTEST_AGENT_SECRET" | "LEASH_SDKTEST_RISKOFF_SECRET"): Keypair {
  const secret = env[name];
  if (!secret) throw new Error(`Missing ${name} in .env.local: ${SETUP}`);
  return Keypair.fromSecret(secret);
}

export const testLeash = () => new Leash({ deployments: fixtures });
