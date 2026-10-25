import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../../deployments/testnet.json", import.meta.url));

export type AdapterName = "Blend" | "DeFindex" | "Aquarius" | "Soroswap" | "Xoxno";

export interface VaultRecord {
  id: string;
  name: string;
  slug: string;
  strategy: string;
  roles: string[];
  address: string;
  factory: string;
  owner: string;
  agent: string;
  registry: string;
  oracle: string;
  assets: string[];
  adapters: { kind: AdapterName; protocol: string }[];
  deployTx: string;
  /** Set once the policy is registered, before any deposit. */
  policyTx?: string;
  adapterTxs: string[];
  /** Base-asset units deposited by the creator. */
  deposit?: string;
  depositTx?: string;
  /** Initial session-key executions, by action name. */
  executions: { action: string; tx: string }[];
}

/** Shape of `deployments/testnet.json`; fields appear as `deploy.ts` then `seed.ts` record them. */
export interface TestnetDeployment {
  network: "testnet";
  admin?: string;
  agent?: string;
  /** Second factory admin and performance-fee protocol recipient. */
  keeper?: string;
  /** Demo-capable router (`demo` feature) the fleet prices through. */
  oracleRouter?: string;
  /** Production build of the router, without forced prices. */
  oracleRouterStrict?: string;
  policyRegistry?: string;
  factory?: string;
  signalBudget?: string;
  vaultRef?: string;
  timelocks?: { policySecs: number; factorySecs: number };
  wasm?: Record<string, string>;
  transactions?: Record<string, string>;
  protocols?: Record<string, string>;
  liquidity?: Record<string, string>;
  vaults: VaultRecord[];
}

export function readTestnet(): TestnetDeployment {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<TestnetDeployment>;
  return { ...parsed, network: "testnet", vaults: parsed.vaults ?? [] };
}

export function writeTestnet(deployment: TestnetDeployment): void {
  writeFileSync(file, `${JSON.stringify(deployment, null, 2)}\n`);
}
