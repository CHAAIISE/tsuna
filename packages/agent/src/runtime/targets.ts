import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { Deployments } from "@leash/sdk";
import { STRATEGY_IDS, type StrategyId } from "./strategies.js";
import { z } from "zod";

/** Blend testnet assets held by Leash vaults. */
export const TESTNET_ASSETS = {
  USDC: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
  XLM: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
} as const;

/**
 * Environment variable holding the demo fleet's member key for `role`: the
 * session key `LEASH_AGENT_SECRET` for `default`, `LEASH_<ROLE>_SECRET` otherwise
 * (`LEASH_RISKOFF_SECRET`).
 */
export function memberEnv(role: string): string {
  return role === "default" ? "LEASH_AGENT_SECRET" : `LEASH_${role.toUpperCase()}_SECRET`;
}

/** A vault the agent can run on, from `deployments/testnet.json` or an extra deployment file. */
export interface VaultTarget {
  id: string;
  name: string;
  address: string;
  strategyId?: StrategyId;
  adapters: { kind: string; protocol: string }[];
  /** Known members per role and the environment variable holding each key. */
  roles: Record<string, { member?: string; env: string }>;
  feePayerEnv?: string;
}

const memberRecord = z.object({ member: z.string(), env: z.string() });
const extraDeployment = z.object({
  vaults: z.array(z.object({
    id: z.string(),
    name: z.string(),
    address: z.string(),
    agent: z.string(),
    strategyId: z.string().optional(),
    adapters: z.array(z.object({ kind: z.string(), protocol: z.string() })),
    roles: z.record(z.string(), memberRecord).optional(),
    feePayer: z.object({ address: z.string(), env: z.string() }).optional(),
  })).default([]),
});

/** Vaults deployed outside the demo fleet with keys of their own (`scripts/agent-vault.ts`). */
export const EXTRA_DEPLOYMENTS = process.env.LEASH_AGENT_DEPLOYMENTS
  ?? fileURLToPath(new URL("../../../../deployments/agent.testnet.json", import.meta.url));

const strategyId = (value: string | undefined) => STRATEGY_IDS.find(id => id === value);

/** Every vault the runtime knows: the demo fleet, then the extra deployment file when present. */
export function knownVaults(deployments: Deployments, extraFile = EXTRA_DEPLOYMENTS): VaultTarget[] {
  const fleet: VaultTarget[] = deployments.vaults.map(vault => {
    const strategy = strategyId(vault.id);
    const roles = vault.roles?.length ? vault.roles : ["default"];
    return {
      id: vault.id,
      name: vault.name,
      address: vault.address,
      ...(strategy ? { strategyId: strategy } : {}),
      adapters: vault.adapters ?? [],
      roles: Object.fromEntries(roles.map(role => [role, {
        ...(role === "default" && vault.agent ? { member: vault.agent } : {}),
        env: memberEnv(role),
      }])),
    };
  });
  if (!existsSync(extraFile)) return fleet;
  const extra = extraDeployment.parse(JSON.parse(readFileSync(extraFile, "utf8"))).vaults;
  return fleet.concat(extra.map(vault => {
    const strategy = strategyId(vault.strategyId);
    return {
      id: vault.id,
      name: vault.name,
      address: vault.address,
      ...(strategy ? { strategyId: strategy } : {}),
      adapters: vault.adapters,
      roles: vault.roles ?? { default: { member: vault.agent, env: memberEnv("default") } },
      ...(vault.feePayer ? { feePayerEnv: vault.feePayer.env } : {}),
    };
  }));
}

/** Finds a vault by id, name (case-insensitive) or contract address. */
export function resolveVault(target: string, vaults: VaultTarget[]): VaultTarget {
  const wanted = target.toLowerCase();
  const found = vaults.find(vault => vault.address === target || vault.id.toLowerCase() === wanted || vault.name.toLowerCase() === wanted);
  if (found) return found;
  if (StrKey.isValidContract(target)) return { id: target, name: target, address: target, adapters: [], roles: { default: { env: memberEnv("default") } } };
  throw new Error(`Unknown vault "${target}"; known: ${vaults.map(vault => vault.id).join(", ")}`);
}

const keyFromEnv = (name: string) => {
  const secret = process.env[name];
  if (!secret) throw new Error(`Missing ${name}`);
  return Keypair.fromSecret(secret);
};

/**
 * Member key for `role` on `vault` (from the environment variable recorded for
 * that role) and the optional separate fee payer. Refuses a key that is not the
 * member the deployment records, rather than sending a call bound to fail.
 */
export function resolveKeys(vault: VaultTarget, role: string): { member: Keypair; feePayer?: Keypair } {
  const entry = vault.roles[role] ?? { env: memberEnv(role) };
  const member = keyFromEnv(entry.env);
  if (entry.member && member.publicKey() !== entry.member) {
    throw new Error(`${entry.env} is not the ${role} member of ${vault.name} (${entry.member})`);
  }
  return { member, ...(vault.feePayerEnv ? { feePayer: keyFromEnv(vault.feePayerEnv) } : {}) };
}
