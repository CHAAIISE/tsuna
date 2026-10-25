import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cwd, env } from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const adapterKind = z.enum(["Blend", "DeFindex", "Aquarius", "Soroswap", "Xoxno"]);

const vaultRecord = z.looseObject({
  id: z.string(),
  name: z.string(),
  slug: z.string().optional(),
  strategy: z.string().optional(),
  roles: z.array(z.string()).optional(),
  address: z.string(),
  factory: z.string().optional(),
  owner: z.string().optional(),
  agent: z.string().optional(),
  registry: z.string().optional(),
  oracle: z.string().optional(),
  assets: z.array(z.string()).optional(),
  adapters: z.array(z.object({ kind: adapterKind, protocol: z.string() })).optional(),
});

const deployments = z.looseObject({
  network: z.string(),
  oracleRouter: z.string().optional(),
  oracleRouterStrict: z.string().optional(),
  policyRegistry: z.string().optional(),
  factory: z.string().optional(),
  signalBudget: z.string().optional(),
  admin: z.string().optional(),
  agent: z.string().optional(),
  keeper: z.string().optional(),
  vaultRef: z.string().optional(),
  wasm: z.record(z.string(), z.string()).optional(),
  timelocks: z.object({ policySecs: z.number(), factorySecs: z.number() }).optional(),
  protocols: z.record(z.string(), z.string()).optional(),
  vaults: z.array(vaultRecord).default([]),
});

/** Typed view of `deployments/testnet.json` (or a file of the same shape). */
export type Deployments = z.infer<typeof deployments>;
export type VaultRecord = z.infer<typeof vaultRecord>;
export type AdapterKind = z.infer<typeof adapterKind>;

/** First ancestor of `start` holding `pnpm-workspace.yaml`. */
function repoRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Default deployments file: `LEASH_DEPLOYMENTS`, else `<repo root>/deployments/testnet.json`. */
export function defaultDeploymentsPath(): string {
  if (env.LEASH_DEPLOYMENTS) return resolve(env.LEASH_DEPLOYMENTS);
  const root = repoRoot(dirname(fileURLToPath(import.meta.url))) ?? repoRoot(cwd());
  if (!root) throw new Error("Cannot locate the repository root: set LEASH_DEPLOYMENTS");
  return join(root, "deployments", "testnet.json");
}

export function parseDeployments(value: unknown): Deployments {
  return deployments.parse(value);
}

export function loadDeployments(path: string = defaultDeploymentsPath()): Deployments {
  // The path is only known at runtime: keep bundlers from tracing the whole repository for it.
  return parseDeployments(JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")));
}

/** `deployments[key]`, or an error naming the missing entry. */
export function required(record: Deployments, key: "oracleRouter" | "policyRegistry" | "factory" | "keeper"): string {
  const value = record[key];
  if (!value) throw new Error(`Missing ${key} in the deployments file`);
  return value;
}
