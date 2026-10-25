import { Address, rpc, xdr } from "@stellar/stellar-sdk";

/** What the keeper knows about one vault's allowlisted protocols. */
export interface WatchedVault {
  address: string;
  name: string;
  protocols: string[];
  /** Hash (hex) the vault pinned per protocol; `null` while unpinned. */
  pinned: Record<string, string | null>;
  /** Protocols already halting the vault, waiting for the owner's acknowledgement. */
  halted: string[];
}

export interface ProtocolUpgrade {
  vault: string;
  name: string;
  protocol: string;
  pinned: string;
  current: string;
}

export interface ProtocolPlan {
  upgrades: ProtocolUpgrade[];
  /** Vaults to send `check_protocols` to: upgraded protocols to pause on, or hashes to pin. */
  check: string[];
}

/**
 * Compares each vault's pinned hashes with the hashes currently on-chain (`null` for
 * Stellar Asset contracts, which never change code). A protocol the vault already halted on
 * is not reported twice.
 */
export function planProtocolChecks(vaults: readonly WatchedVault[], current: ReadonlyMap<string, string | null>): ProtocolPlan {
  const upgrades: ProtocolUpgrade[] = [];
  const check = new Set<string>();
  for (const vault of vaults) {
    for (const protocol of vault.protocols) {
      const now = current.get(protocol);
      if (!now) continue;
      const pinned = vault.pinned[protocol] ?? null;
      if (pinned === null) {
        check.add(vault.address);
      } else if (pinned !== now && !vault.halted.includes(protocol)) {
        upgrades.push({ vault: vault.address, name: vault.name, protocol, pinned, current: now });
        check.add(vault.address);
      }
    }
  }
  return { upgrades, check: [...check] };
}

function isMissing(error: unknown): boolean {
  // The RPC client rejects with a plain `{ code: 404 }` object for missing entries.
  return typeof error === "object" && error !== null && "code" in error && error.code === 404;
}

/**
 * Wasm hash (hex) a contract currently runs, read from its instance entry with
 * `getLedgerEntries`. A CAP-85 executable reference is resolved through its owner's tag
 * entry. `null` for Stellar Asset contracts and missing contracts.
 */
export async function executableHash(server: rpc.Server, contract: string): Promise<string | null> {
  let entry: rpc.Api.LedgerEntryResult;
  try {
    entry = await server.getContractData(contract, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const data = entry.val;
  if (data.type !== "contractData" || data.contractData.val.type !== "scvContractInstance") return null;
  const executable = data.contractData.val.instance.executable;
  switch (executable.type) {
    case "contractExecutableWasm":
      return Buffer.from(executable.wasmHash.toBytes()).toString("hex");
    case "contractExecutableStellarAsset":
      return null;
    case "contractExecutableExternalRef": {
      const { executableOwner, tag } = executable.externalRef;
      const owner = Address.fromScAddress(executableOwner).toString();
      const ref = await server.getContractData(owner, xdr.ScVal.scvExecutableTag(tag), rpc.Durability.Persistent);
      const value = ref.val;
      if (value.type !== "contractData" || value.contractData.val.type !== "scvBytes") {
        throw new Error(`Executable reference of ${contract} does not hold a Wasm hash`);
      }
      return Buffer.from(value.contractData.val.bytes.toBytes()).toString("hex");
    }
  }
}

/** Current hash of every distinct protocol across `vaults`. */
export async function currentHashes(server: rpc.Server, vaults: readonly WatchedVault[]): Promise<Map<string, string | null>> {
  const protocols = [...new Set(vaults.flatMap(vault => vault.protocols))];
  const hashes = await Promise.all(protocols.map(protocol => executableHash(server, protocol)));
  return new Map(protocols.map((protocol, i) => [protocol, hashes[i] ?? null]));
}
