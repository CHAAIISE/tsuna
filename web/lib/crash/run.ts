import "server-only";
import { randomUUID } from "node:crypto";
import { Address, Contract, Keypair, xdr } from "@stellar/stellar-sdk";
import { BlendRequest, TESTNET, blendRequestVal } from "@leash/sdk";
import {
  CRASH_VAULT_ID, CrashError, CrashScenario, readCrashLive, type CrashKeys, type CrashLive, type CrashTx, type JournalEntry,
} from "@leash/agent";
import { ensureTrustline } from "#cctp/stellar";
import { cached, decodeError, invalidate, leash } from "@/lib/stellar/client";
import { fleet } from "@/lib/stellar/deployments";
import { ApiError } from "@/lib/stellar/http";
import { appendJournal } from "@/lib/stellar/journal-store";
import { runTimeline } from "@/lib/stellar/timeline";
import type { CrashLiveView, CrashResponse, CrashRunView, CrashStepId, CrashStepView, CrashTxView } from "./types";

/** A run left with the demo price or the pause in place is restored after this much silence. */
const IDLE_MS = 10 * 60 * 1000;
const LIVE_TTL = 4_000;
/** What the demo depositor puts in before the crash, base units (1 USDC). */
const DEPOSIT = 10_000_000n;
/** Test USDC the demo depositor borrows on Blend once, against XLM from Friendbot (5 USDC against 200 XLM). */
const FUNDING = { borrow: 50_000_000n, collateral: 2_000_000_000n };

const vaultRecord = fleet.vaults.find(vault => vault.id === CRASH_VAULT_ID);

/** The fee payer and the depositor are this demo's own keys; the fleet's keys only sign authorization entries. */
const KEY_NAMES = {
  admin: "LEASH_ADMIN_SECRET",
  agent: "LEASH_AGENT_SECRET",
  riskoff: "LEASH_RISKOFF_SECRET",
  feePayer: "LEASH_CRASH_FEE_SECRET",
  depositor: "LEASH_CRASH_DEPOSITOR_SECRET",
} as const;

function crashKeys(): CrashKeys | string {
  const missing = Object.values(KEY_NAMES).filter(name => !process.env[name]);
  if (missing.length > 0) return `This server does not hold the testnet keys of the crash demo (${missing.join(", ")}).`;
  if (!process.env.OPENAI_API_KEY) return "The risk-off agent's model is not configured on this server.";
  const key = (name: string) => Keypair.fromSecret(process.env[name] as string);
  const feePayer = key(KEY_NAMES.feePayer);
  // check_drawdown is permissionless: the fee payer calls it as the keeper would.
  return {
    admin: key(KEY_NAMES.admin), agent: key(KEY_NAMES.agent), riskoff: key(KEY_NAMES.riskoff),
    keeper: feePayer, depositor: key(KEY_NAMES.depositor), feePayer,
  };
}

interface Run {
  id: string;
  startedAt: string;
  updatedAt: number;
  keys: CrashKeys;
  scenario: CrashScenario;
  busy: CrashStepId | null;
  steps: Map<CrashStepId, CrashStepView>;
  /** Journal id and entries of the risk-off agent's latest run. */
  agentRunId: string | null;
  entries: JournalEntry[];
  autoRestored: boolean;
  idle?: NodeJS.Timeout;
}

/** The one crash run of this server: steps share the fee payer and the vault, so they never overlap. */
let current: Run | null = null;

const txView = (tx: CrashTx): CrashTxView => ({
  label: tx.label, hash: tx.hash, status: tx.status,
  error: tx.error ? { contract: tx.error.contract, code: tx.error.code, name: tx.error.name, message: tx.error.message } : null,
});

function runView(run: Run): CrashRunView {
  return {
    id: run.id,
    startedAt: run.startedAt,
    busy: run.busy,
    next: run.scenario.next(),
    steps: [...run.steps.values()],
    needsRestore: run.scenario.needsRestore,
    autoRestored: run.autoRestored,
    journal: run.agentRunId ? runTimeline(run.agentRunId, "riskoff", run.entries) : [],
  };
}

function liveView(live: CrashLive): CrashLiveView {
  const text = (value: bigint | null) => (value === null ? null : value.toString());
  return {
    demo: live.demo, forcedPrice: text(live.forcedPrice), xlmPrice: text(live.xlmPrice), healthFactorBps: text(live.healthFactor),
    minHealthBps: live.minHealth, maxDrawdownBps: live.maxDrawdown, nav: text(live.nav), pps: text(live.pps),
    paused: live.paused, debt: text(live.debt), asOf: new Date().toISOString(),
  };
}

/**
 * Accounts, USDC trustline and test USDC the demo depositor needs before its deposit, each
 * transaction appended to `txs` as it lands. The USDC is borrowed on Blend against Friendbot XLM.
 */
async function fundDepositor(keys: CrashKeys, vault: string, txs: CrashTxView[]): Promise<void> {
  const client = leash();
  for (const [key, who] of [[keys.feePayer, "the fee payer"], [keys.depositor, "the demo depositor"]] as const) {
    if (!key) continue;
    try {
      await client.server.getAccount(key.publicKey());
    } catch {
      const funded = await client.server.fundAddress(key.publicKey());
      txs.push({ label: `Friendbot funds ${who}`, hash: funded.txHash, status: "SUCCESS", error: null });
    }
  }
  const depositor = new Address(keys.depositor.publicKey()).toScVal();
  if (await client.vault(vault).sharesOf(keys.depositor.publicKey()) > 0n) return;
  const trust = await ensureTrustline(keys.depositor, TESTNET.usdc, TESTNET.usdcIssuer);
  if (trust) txs.push({ label: "Demo depositor opens its USDC trustline", hash: trust, status: "SUCCESS", error: null });
  if (await client.read<bigint>(TESTNET.usdc, "balance", [depositor]) >= DEPOSIT) return;
  const borrowed = await client.chain.invoke(keys.depositor, new Contract(TESTNET.blendPool).call("submit", depositor, depositor, depositor, xdr.ScVal.scvVec([
    blendRequestVal(TESTNET.xlm, FUNDING.collateral, BlendRequest.SupplyCollateral),
    blendRequestVal(TESTNET.usdc, FUNDING.borrow, BlendRequest.Borrow),
  ])), [keys.depositor]);
  txs.push({ label: "Demo depositor borrows 5 test USDC on Blend against 200 XLM", hash: borrowed.hash, status: borrowed.status, error: null });
  if (borrowed.status !== "SUCCESS") throw new CrashError("The demo depositor could not borrow test USDC on Blend.");
}

function message(error: unknown): string {
  if (error instanceof CrashError || error instanceof ApiError) return error.message;
  const typed = decodeError(error);
  if (typed) return `The chain refused: ${typed.name} — ${typed.message}`;
  console.error("crash demo:", error instanceof Error ? error.message : error);
  return "Stellar testnet did not respond. Try the step again in a moment.";
}

/** Records activity on `run` and re-arms its idle restore while it holds the demo price or the pause. */
function touch(run: Run): void {
  run.updatedAt = Date.now();
  clearTimeout(run.idle);
  if (!run.scenario.needsRestore) return;
  run.idle = setTimeout(() => void idleRestore(run)?.(), IDLE_MS);
  run.idle.unref?.();
}

/** Restore task for a run left crashed past the idle delay, if it is due. */
function idleRestore(run: Run): (() => Promise<void>) | null {
  if (current !== run || run.busy || !run.scenario.needsRestore || Date.now() - run.updatedAt < IDLE_MS) return null;
  run.autoRestored = true;
  return reserve(run, "restore");
}

function journalRun(run: Run, status: "running" | "finished" | "failed"): void {
  if (!run.agentRunId) return;
  appendJournal({
    type: "run", runId: run.agentRunId, vault: run.scenario.vaultAddress, status, role: "riskoff",
    model: process.env.OPENAI_MODEL || null, at: new Date().toISOString(),
  }).catch((reason: unknown) => console.error("crash journal:", reason instanceof Error ? reason.message : reason));
}

/** Marks `step` as running on `run` and returns the task that runs it. */
function reserve(run: Run, step: CrashStepId): () => Promise<void> {
  run.busy = step;
  return async () => {
    const funding: CrashTxView[] = [];
    try {
      if (step === "prepare") await fundDepositor(run.keys, run.scenario.vaultAddress, funding);
      if (step === "riskoff-repay") {
        run.agentRunId = randomUUID();
        run.entries = [];
        journalRun(run, "running");
      }
      const result = await run.scenario.run(step);
      run.steps.set(step, {
        id: step, status: result.ok ? "done" : "failed", at: new Date().toISOString(),
        txs: [...funding, ...result.txs.map(txView)], notes: result.notes,
        error: result.ok ? null : "Part of the restore did not land: run it again.",
      });
    } catch (error) {
      run.steps.set(step, { id: step, status: "failed", at: new Date().toISOString(), txs: funding, notes: [], error: message(error) });
    } finally {
      if (step === "riskoff-repay") journalRun(run, run.steps.get(step)?.status === "done" ? "finished" : "failed");
      run.busy = null;
      touch(run);
      const vault = run.scenario.vaultAddress;
      for (const key of ["crash:live", `vault:${vault}`, `activity:${vault}`, "agents", "events"]) invalidate(key);
    }
  };
}

function newRun(keys: CrashKeys): Run {
  const run: Run = {
    id: randomUUID(), startedAt: new Date().toISOString(), updatedAt: Date.now(), keys, busy: null, steps: new Map(),
    agentRunId: null, entries: [], autoRestored: false,
    scenario: new CrashScenario({
      leash: leash(), keys, depositAmount: DEPOSIT,
      onEntry: entry => {
        run.entries.push(entry);
        if (!run.agentRunId) return;
        appendJournal({ type: "entry", runId: run.agentRunId, vault: run.scenario.vaultAddress, entry })
          .catch((reason: unknown) => console.error("crash journal:", reason instanceof Error ? reason.message : reason));
      },
    }),
  };
  return run;
}

/**
 * Reserves `step` of the crash run and returns the task that runs it. `prepare` opens a new run
 * unless another one is under way; `restore` also recovers a demo price a lost run left behind.
 */
export async function startStep(step: CrashStepId): Promise<{ run: CrashRunView; task: () => Promise<void> }> {
  if (!vaultRecord) throw new ApiError("No crash vault in the deployments file.", 404);
  const keys = crashKeys();
  if (typeof keys === "string") throw new ApiError(keys, 503);
  if (current?.busy) throw new ApiError("A crash step is running on the vault right now. Wait for it to land.", 409);
  if (step === "prepare") {
    const next = current?.scenario.next();
    const underWay = current && (current.scenario.needsRestore || (next && next !== "prepare" && Date.now() - current.updatedAt < IDLE_MS));
    if (underWay) throw new ApiError("A crash demo is already under way on this vault: follow it here, or restore it first.", 409);
    clearTimeout(current?.idle);
    current = newRun(keys);
  } else if (step === "restore") {
    if (!current?.scenario.needsRestore) {
      // Only a demo price left by a run this server lost (a restart) is restored from scratch.
      if (await readCrashLive(leash()).then(live => live.forcedPrice === null)) {
        throw new ApiError("Nothing to restore: the demo oracle forces no price.", 409);
      }
      clearTimeout(current?.idle);
      current = newRun(keys);
    }
  } else {
    if (!current) throw new ApiError("Start with the first step.", 409);
    if (step !== current.scenario.next()) throw new ApiError("This step is not next: refresh the panel.", 409);
  }
  const run = current;
  return { run: runView(run), task: reserve(run, step) };
}

/** Live readings and the current run; a run idle past its delay returns its own restore task. */
export async function crashState(vaultId: string | null): Promise<{ body: CrashResponse; task: (() => Promise<void>) | null }> {
  const record = vaultRecord;
  if (!record || (vaultId !== null && ![record.id, record.slug, record.address].includes(vaultId))) {
    return { body: { vault: null, unavailable: null, live: null, liveError: null, run: null }, task: null };
  }
  const keys = crashKeys();
  const task = current ? idleRestore(current) : null;
  let live: CrashLiveView | null = null;
  let liveError: string | null = null;
  try {
    live = liveView(await cached("crash:live", LIVE_TTL, () => readCrashLive(leash())));
  } catch (error) {
    liveError = message(error);
  }
  return {
    body: {
      vault: { id: record.slug ?? record.id, address: record.address, name: record.name },
      unavailable: typeof keys === "string" ? keys : null,
      live, liveError,
      run: current ? runView(current) : null,
    },
    task,
  };
}
