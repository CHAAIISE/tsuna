import { setTimeout as sleep } from "node:timers/promises";
import { signer } from "./lib/stellar.js";
import { Leash, explorerTx, loadDeployments } from "../packages/sdk/dist/index.js";
import { fetchSnapshots } from "../packages/sdk/src/leaderboard.js";
import { runAgent } from "../packages/agent/src/runtime/run.js";
import { runKeeper } from "../packages/agent/src/keeper.js";

const CYCLES = 5;
const INTERVAL_MS = 30_000;
const VAULT_IDS = ["prudent", "leverage", "liquidity"] as const;

async function main(): Promise<void> {
  const deployments = loadDeployments();
  if (deployments.network !== "testnet") throw new Error("Warmup only supports Stellar testnet");
  const leash = new Leash({ deployments });
  const keeper = signer("LEASH_KEEPER_SECRET");
  const vaults = VAULT_IDS.map(id => {
    const record = deployments.vaults.find(vault => vault.id === id);
    if (!record) throw new Error(`Missing demo vault ${id}`);
    return record;
  });
  const snapshotTxs = new Map(vaults.map(vault => [vault.address, new Set<string>()]));

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    console.log(`CYCLE ${cycle}/${CYCLES}`);
    // The demo vaults share signing accounts, so transactions must remain sequential.
    for (const record of vaults) {
      if (await leash.vault(record.address).paused()) throw new Error(`${record.id} is paused; resolve the cause before warmup`);
      const result = await runAgent({
        vault: record.id,
        deployments,
        leash,
        onEntry: entry => console.log(JSON.stringify({ cycle, vault: record.id, ...entry })),
      });
      for (const tx of result.transactions) {
        const onChain = await leash.server.getTransaction(tx.hash);
        console.log(`EXECUTE ${record.id} ${onChain.status} ${tx.hash} ${explorerTx(tx.hash)}`);
        if (onChain.status !== "SUCCESS" || tx.status !== "SUCCESS") {
          throw new Error(`${record.id}: execute failed (${tx.error ?? onChain.status}), ${tx.hash}`);
        }
      }
      console.log(`AGENT ${record.id} steps=${result.steps} submitted=${result.transactions.length}`);
    }

    const report = await runKeeper({
      leash,
      keeper,
      vaults: vaults.map(vault => vault.address),
      onEntry: entry => console.log(JSON.stringify({ cycle, ...entry })),
    });
    for (const record of vaults) {
      const entries = report.entries.filter(entry => entry.vault === record.address);
      const snapshot = entries.find(entry => entry.kind === "drawdown checked");
      if (entries.some(entry => entry.kind === "error" || entry.kind === "skipped" || entry.paused)
        || !snapshot?.tx || snapshot.tx.status !== "SUCCESS") {
        throw new Error(`${record.id}: keeper did not complete healthy checks`);
      }
      const onChain = await leash.server.getTransaction(snapshot.tx.hash);
      if (onChain.status !== "SUCCESS") throw new Error(`${record.id}: snapshot transaction ${snapshot.tx.hash} is ${onChain.status}`);
      snapshotTxs.get(record.address)!.add(snapshot.tx.hash);
      console.log(`SNAPSHOT ${record.id} ${snapshot.tx.hash} ${explorerTx(snapshot.tx.hash)}`);
    }
    if (cycle < CYCLES) await sleep(INTERVAL_MS);
  }

  // Count emitted events, not successful calls: the leaderboard consumes these same RPC events.
  const { snapshots } = await fetchSnapshots(leash.server, vaults.map(vault => vault.address));
  for (const record of vaults) {
    const history = snapshots.filter(snapshot => snapshot.vault === record.address);
    const generated = history.filter(snapshot => snapshotTxs.get(record.address)!.has(snapshot.txHash));
    const confirmed = new Set(generated.map(snapshot => snapshot.txHash));
    if (confirmed.size < CYCLES) {
      throw new Error(`${record.id}: getEvents returned ${confirmed.size}/${CYCLES} new keeper snapshots`);
    }
    const first = generated[0]!;
    const last = generated.at(-1)!;
    console.log(`HISTORY ${record.id} new=${confirmed.size} retained=${history.length} from=${first.ts} to=${last.ts} nav=${last.nav} pps=${last.pps}`);
  }
  console.log(`WARMUP OK vaults=${vaults.length} cycles=${CYCLES} snapshots_per_vault>=${CYCLES}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
