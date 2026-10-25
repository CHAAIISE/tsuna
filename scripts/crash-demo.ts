/**
 * Crash scenario on the demo Leverage vault (testnet): the demo oracle drops XLM by 30 %, the
 * yield agent is refused `HealthFactorTooLow`, the keeper's `check_drawdown` pauses the vault,
 * the risk-off role is refused `RiskIncreased` when it tries to borrow, the risk-off agent repays
 * Blend debt while paused, and Alice withdraws. Every step is a real transaction read back with
 * `getTransaction` (see `CrashScenario` in `@leash/agent`). The price, the pause and the Blend
 * book are restored at the end so the scenario can run again.
 */
import { LEVERAGE_MAX_DRAWDOWN_BPS, UNIT, fail, signer } from "./lib/stellar.js";
import { ensureBlendUsdc } from "./lib/pay.js";
import { Leash, explorerTx, loadDeployments } from "../packages/sdk/src/index.js";
import {
  CRASH_STEPS, CRASH_VAULT_ID, CrashScenario, type CrashStepResult,
} from "../packages/agent/src/crash.js";
import type { JournalEntry } from "../packages/agent/src/runtime/journal.js";

const ALICE_DEPOSIT = UNIT;

const deployments = loadDeployments();
const leash = new Leash({ deployments });
const found = deployments.vaults.find(v => v.id === CRASH_VAULT_ID);
if (!found) throw new Error(`Vault ${CRASH_VAULT_ID} is not in the deployments file`);
const vault = leash.vault(found.address);

const admin = signer("LEASH_ADMIN_SECRET");
const alice = signer("E2E_USER_SECRET");

const printEntry = (entry: JournalEntry) => {
  const detail = entry.kind === "model"
    ? entry.text
    : [entry.input, entry.output, entry.error, ...(entry.simulation ?? []).map(s => (s.ok ? "sim ok" : `sim ${s.error}`)),
      ...(entry.tx ?? []).map(t => `${t.status}${t.error ? ` ${t.error}` : ""} ${t.hash}`)].filter(Boolean).join(" | ");
  console.log(`  [risk-off agent] ${entry.tool ?? "model"}: ${(detail ?? "").replace(/\s+/g, " ").slice(0, 240)}`);
};

const scenario = new CrashScenario({
  deployments,
  keys: {
    admin,
    agent: signer("LEASH_AGENT_SECRET"),
    riskoff: signer("LEASH_RISKOFF_SECRET"),
    keeper: signer("LEASH_KEEPER_SECRET"),
    depositor: alice,
  },
  depositAmount: ALICE_DEPOSIT,
  onEntry: printEntry,
});

const hashes: string[] = [];
let failed = false;

function print(result: CrashStepResult): void {
  console.log(`STEP ${result.step}`);
  for (const tx of result.txs) {
    console.log(`  ${tx.status}${tx.error ? ` ${tx.error.name}` : ""} ${tx.label} ${tx.hash} ${explorerTx(tx.hash)}`);
    hashes.push(`${result.step} ${tx.hash}`);
  }
  for (const note of result.notes) console.log(`  ${note}`);
}

/** Drawdown breaker sized to the vault's XLM book, and USDC for Alice's deposit. */
async function setUp(): Promise<void> {
  console.log(`VAULT ${found?.name} ${vault.address}`);
  const policy = await vault.policy();
  const limit = policy.limits.max_drawdown_bps;
  if (limit > LEVERAGE_MAX_DRAWDOWN_BPS) {
    const tightened = await leash.proposePolicy(admin, vault.address, {
      ...policy, limits: { ...policy.limits, max_drawdown_bps: LEVERAGE_MAX_DRAWDOWN_BPS },
    });
    console.log(`DRAWDOWN_LIMIT ${limit} -> ${LEVERAGE_MAX_DRAWDOWN_BPS} bps ${tightened.status} ${tightened.hash}`);
    const inForce = (await vault.policy()).limits.max_drawdown_bps;
    if (inForce !== LEVERAGE_MAX_DRAWDOWN_BPS) throw new Error(`The registry did not apply the tighter drawdown (${inForce} bps in force)`);
  } else {
    console.log(`DRAWDOWN_LIMIT ${limit} bps in force (target ${LEVERAGE_MAX_DRAWDOWN_BPS} bps)`);
  }
  if (await vault.sharesOf(alice.publicKey()) === 0n) await ensureBlendUsdc(alice, ALICE_DEPOSIT);
}

try {
  await setUp();
  for (const step of CRASH_STEPS) print(await scenario.run(step));
} catch (error) {
  failed = true;
  fail(error);
} finally {
  if (scenario.needsRestore) {
    try {
      const restored = await scenario.run("restore");
      print(restored);
      if (!restored.ok) failed = true;
    } catch (error) {
      failed = true;
      fail(error);
    }
  }
}

console.log("\nSUMMARY");
for (const line of hashes) console.log(`  ${line}`);
console.log(failed ? "CRASH_DEMO FAILED" : "CRASH_DEMO OK");
process.exitCode = failed ? 1 : 0;
