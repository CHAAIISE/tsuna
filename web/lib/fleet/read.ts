import "server-only";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { fleetConfig, fleetRecord, leash, type FleetConfig, type FleetId } from "./config";
import { contractMeta, exportedFunctions } from "./wasm";

/** Functions every `agent_vault` build exports; a fleet may only move to a build that has them. */
const VAULT_INTERFACE = ["deposit", "withdraw", "execute", "execute_as", "nav", "owner", "set_paused"];

export interface BuildInfo {
  hash: string;
  /** From `deployments/fleet.testnet.json`; `null` for a build nobody described. */
  title: string | null;
  description: string | null;
  /** `contractmetav0` entries of the uploaded Wasm, read from the ledger. */
  meta: Record<string, string>;
}

export interface FleetVault {
  address: string;
  name: string;
  /** CAP-85 reference in the vault's instance entry; `null` for a vault with its own Wasm. */
  executableRef: { owner: string; tag: string } | null;
  /** Wasm the vault runs right now, resolved through its reference. */
  wasmHash: string | null;
  /** The two fields PolicyV2 added; `null` reads as "not set" (CAP-86: absent → None). */
  policy: { registered: false } | { registered: true; exposureCaps: number | null; roles: string[] | null };
  /** Set for vaults the setup script registered from a v1-shaped policy map. */
  registeredAsV1?: string;
}

export interface FleetState {
  id: FleetId;
  label: string;
  factory: string;
  tag: string;
  timelockSecs: number;
  admins: [string, string];
  current: BuildInfo | null;
  pending: { build: BuildInfo; eta: number } | null;
  /** Described builds the fleet could move to (uploaded, vault interface, not current). */
  candidates: BuildInfo[];
  vaults: FleetVault[];
}

const wasmCache = new Map<string, Promise<Uint8Array | null>>();

/** Uploaded Wasm of `hash`, or `null` when the ledger does not hold it. */
export function uploadedWasm(hash: string): Promise<Uint8Array | null> {
  let cached = wasmCache.get(hash);
  if (!cached) {
    cached = leash().server.getContractWasmByHash(Buffer.from(hash, "hex"))
      .then(wasm => new Uint8Array(wasm))
      .catch(() => null);
    // A missing build may be uploaded later: only cache hits.
    void cached.then(wasm => { if (!wasm) wasmCache.delete(hash); });
    wasmCache.set(hash, cached);
  }
  return cached;
}

/** True when `wasm` exports the whole vault interface. */
export function isVaultBuild(wasm: Uint8Array): boolean {
  const exported = new Set(exportedFunctions(wasm));
  return VAULT_INTERFACE.every(name => exported.has(name));
}

export async function buildInfo(hash: string): Promise<BuildInfo> {
  const described = fleetRecord.builds.find(build => build.hash === hash);
  const wasm = await uploadedWasm(hash);
  return {
    hash,
    title: described?.title ?? null,
    description: described?.description ?? null,
    meta: wasm ? contractMeta(wasm) : {},
  };
}

const hex = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("hex");

async function readVault(address: string, config: FleetConfig): Promise<FleetVault> {
  const client = leash();
  const instance = await client.server.getContractInstance(address);
  const { executable } = instance;
  let executableRef: FleetVault["executableRef"] = null;
  let wasmHash: string | null = null;
  if (executable.type === "contractExecutableExternalRef") {
    const ref = executable.externalRef;
    executableRef = { owner: Address.fromScAddress(ref.executableOwner).toString(), tag: ref.tag.toString() };
    wasmHash = hex(await client.server.getExternalRefWasmHash(ref));
  } else if (executable.type === "contractExecutableWasm") {
    wasmHash = hex(executable.wasmHash.value);
  }
  const policy = await client.vault(address).findPolicy();
  const facts = config.vaults.get(address);
  return {
    address,
    name: facts?.name ?? "Community vault",
    executableRef,
    wasmHash,
    policy: policy
      ? {
        registered: true,
        exposureCaps: policy.exposure_caps ? Object.keys(policy.exposure_caps).length : null,
        roles: policy.roles ? Object.keys(policy.roles) : null,
      }
      : { registered: false },
    ...(facts?.policyShape === "v1" && facts.registerTx ? { registeredAsV1: facts.registerTx } : {}),
  };
}

/** Everything the fleet page shows, read from the ledger at call time. */
export async function readFleet(id: FleetId): Promise<FleetState | null> {
  const config = fleetConfig(id);
  if (!config) return null;
  const client = leash();
  const tag = nativeToScVal(fleetRecord.tag, { type: "string" });
  const [addresses, current, pending, timelock, admins] = await Promise.all([
    client.read<string[]>(config.factory, "vaults"),
    client.read<Uint8Array | null>(config.factory, "current_ref", [tag]),
    client.read<{ wasm_hash: Uint8Array; eta: bigint } | null>(config.factory, "pending_ref", [tag]),
    client.read<bigint>(config.factory, "timelock"),
    client.read<[string, string]>(config.factory, "admins"),
  ]);
  const currentHash = current ? hex(current) : null;
  const pendingHash = pending ? hex(pending.wasm_hash) : null;
  const [currentBuild, pendingBuild, vaults, candidates] = await Promise.all([
    currentHash ? buildInfo(currentHash) : null,
    pendingHash ? buildInfo(pendingHash) : null,
    Promise.all(addresses.map(address => readVault(address, config))),
    Promise.all(fleetRecord.builds
      .filter(build => build.hash !== currentHash)
      .map(async build => {
        const wasm = await uploadedWasm(build.hash);
        return wasm && isVaultBuild(wasm) ? buildInfo(build.hash) : null;
      })),
  ]);
  return {
    id,
    label: config.label,
    factory: config.factory,
    tag: fleetRecord.tag,
    timelockSecs: Number(timelock),
    admins,
    current: currentBuild,
    pending: pending && pendingBuild ? { build: pendingBuild, eta: Number(pending.eta) } : null,
    candidates: candidates.filter(build => build !== null),
    vaults,
  };
}
