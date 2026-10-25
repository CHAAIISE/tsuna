import "server-only";
import { Keypair } from "@stellar/stellar-sdk";
import { Leash, parseDeployments } from "@leash/sdk";
import { z } from "zod";
import testnet from "../../../deployments/testnet.json" with { type: "json" };
import fleetFile from "../../../deployments/fleet.testnet.json" with { type: "json" };

export const FLEET_IDS = ["demo", "test"] as const;
export type FleetId = (typeof FLEET_IDS)[number];

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const secretNames = z.tuple([z.string(), z.string()]);

const fleetSchema = z.object({
  tag: z.string(),
  /** Uploaded vault builds with the title and description shown for their hash. */
  builds: z.array(z.object({ hash, title: z.string(), description: z.string(), uploadTx: hash.optional() })),
  fleets: z.object({
    demo: z.object({ label: z.string(), adminSecrets: secretNames }),
    test: z.object({
      label: z.string(),
      factory: z.string(),
      adminSecrets: secretNames,
      vaults: z.array(z.object({
        address: z.string(),
        name: z.string(),
        policyShape: z.enum(["v1", "v2"]),
        registerTx: hash,
      })),
    }).optional(),
  }),
});

export const deployments = parseDeployments(testnet);
export const fleetRecord = fleetSchema.parse(fleetFile);

let client: Leash | undefined;

/** Shared SDK client over the testnet deployments (reads are simulations, no key involved). */
export function leash(): Leash {
  client ??= new Leash({ deployments, ...(process.env.STELLAR_RPC_URL ? { rpcUrl: process.env.STELLAR_RPC_URL } : {}) });
  return client;
}

export interface FleetConfig {
  id: FleetId;
  label: string;
  factory: string;
  adminSecrets: [string, string];
  /** Display names and setup facts of vaults recorded for this fleet. */
  vaults: Map<string, { name: string; policyShape?: "v1" | "v2"; registerTx?: string }>;
}

/** The demo fleet is the factory of `deployments/testnet.json`; the test fleet rehearses upgrades. */
export function fleetConfig(id: FleetId): FleetConfig | null {
  if (id === "demo") {
    if (!deployments.factory) return null;
    return {
      id, label: fleetRecord.fleets.demo.label, factory: deployments.factory, adminSecrets: fleetRecord.fleets.demo.adminSecrets,
      vaults: new Map(deployments.vaults.map(vault => [vault.address, { name: vault.name }])),
    };
  }
  const test = fleetRecord.fleets.test;
  if (!test) return null;
  return {
    id, label: test.label, factory: test.factory, adminSecrets: test.adminSecrets,
    vaults: new Map(test.vaults.map(({ address, ...facts }) => [address, facts])),
  };
}

/** A server key from `.env.local`, or `null` when this server is not configured with it. */
export function serverKey(name: string): Keypair | null {
  const secret = process.env[name];
  return secret ? Keypair.fromSecret(secret) : null;
}

export function isFleetId(value: unknown): value is FleetId {
  return typeof value === "string" && (FLEET_IDS as readonly string[]).includes(value);
}
