import type { Keypair } from "@stellar/stellar-sdk";
import { LeashRefusal, type Leash, type TxResult } from "@leash/sdk";
import { currentHashes, planProtocolChecks, type ProtocolUpgrade, type WatchedVault } from "./watch-protocols.js";

export interface KeeperTx {
  hash: string;
  status: TxResult["status"];
  error?: string;
}

export interface KeeperEntry {
  at: string;
  vault: string;
  name: string;
  kind: "protocol upgraded" | "protocols checked" | "drawdown checked" | "skipped" | "error";
  protocol?: string;
  /** Pinned and current Wasm hashes of an upgraded protocol. */
  pinned?: string;
  current?: string;
  /** NAV snapshot recorded by `check_drawdown`, base units. */
  nav?: string;
  paused?: boolean;
  tx?: KeeperTx;
  detail?: string;
}

export interface KeeperOptions {
  leash: Leash;
  /** Pays for and signs the permissionless `check_protocols` and `check_drawdown` calls. */
  keeper: Keypair;
  /** Defaults to every vault the factory deployed. */
  vaults?: string[];
  onEntry?: (entry: KeeperEntry) => void;
}

export interface KeeperReport {
  entries: KeeperEntry[];
  upgrades: ProtocolUpgrade[];
}

function describe(error: unknown): string {
  if (error instanceof LeashRefusal) return error.error.name;
  return error instanceof Error ? error.message : String(error);
}

const txOf = (result: TxResult): KeeperTx => ({
  hash: result.hash,
  status: result.status,
  ...(result.error ? { error: result.error.name } : {}),
});

/**
 * One keeper pass over the fleet: compares each allowlisted protocol's Wasm hash with the
 * hash the vault pinned (an upgrade makes the vault pause itself through `check_protocols`),
 * then calls `check_drawdown`, which pauses past the drawdown limit and records a NAV snapshot.
 * Both calls are permissionless: the keeper only triggers checks the vault runs on-chain.
 */
export async function runKeeper(opts: KeeperOptions): Promise<KeeperReport> {
  const { leash, keeper } = opts;
  const entries: KeeperEntry[] = [];
  const nameOf = (vault: string) =>
    leash.deployments.vaults.find(v => v.address === vault)?.name ?? `${vault.slice(0, 4)}…${vault.slice(-4)}`;
  const log = (entry: Omit<KeeperEntry, "at" | "name">) => {
    const full: KeeperEntry = { at: new Date().toISOString(), name: nameOf(entry.vault), ...entry };
    entries.push(full);
    opts.onEntry?.(full);
  };

  const addresses = opts.vaults ?? await leash.vaultAddresses();
  const watched: WatchedVault[] = [];
  const live: string[] = [];
  for (const address of addresses) {
    const vault = leash.vault(address);
    try {
      const policy = await vault.findPolicy();
      if (!policy) {
        log({ vault: address, kind: "skipped", detail: "no policy registered" });
        continue;
      }
      live.push(address);
      const [pinned, halted] = await Promise.all([
        Promise.all(policy.protocols.map(async p => [p, await vault.protocolHash(p)] as const)),
        vault.haltedProtocols(),
      ]);
      watched.push({ address, name: nameOf(address), protocols: policy.protocols, pinned: Object.fromEntries(pinned), halted });
    } catch (error) {
      log({ vault: address, kind: "error", detail: `read: ${describe(error)}` });
    }
  }

  const plan = planProtocolChecks(watched, await currentHashes(leash.server, watched));
  for (const address of plan.check) {
    try {
      const result = await leash.vault(address).checkProtocols(keeper);
      const upgrades = plan.upgrades.filter(u => u.vault === address);
      for (const upgrade of upgrades) {
        log({ vault: address, kind: "protocol upgraded", protocol: upgrade.protocol, pinned: upgrade.pinned, current: upgrade.current, paused: true, tx: txOf(result) });
      }
      if (upgrades.length === 0) log({ vault: address, kind: "protocols checked", detail: "pinned current protocol hashes", tx: txOf(result) });
    } catch (error) {
      log({ vault: address, kind: "error", detail: `check_protocols: ${describe(error)}` });
    }
  }

  for (const address of live) {
    const vault = leash.vault(address);
    try {
      const result = await vault.checkDrawdown(keeper);
      const [nav, paused] = await Promise.all([vault.nav().catch(() => null), vault.paused()]);
      log({ vault: address, kind: "drawdown checked", ...(nav === null ? {} : { nav: nav.toString() }), paused, tx: txOf(result) });
    } catch (error) {
      log({ vault: address, kind: "error", detail: `check_drawdown: ${describe(error)}` });
    }
  }
  return { entries, upgrades: plan.upgrades };
}
