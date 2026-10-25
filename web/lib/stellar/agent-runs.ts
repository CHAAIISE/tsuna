import "server-only";
import { knownVaults, resolveKeys, resolveVault, runAgent, signalOptions, STRATEGIES, type JournalEntry } from "@leash/agent";
import { randomUUID } from "node:crypto";
import { invalidate, leash } from "./client";
import { fleet } from "./deployments";
import { ApiError } from "./http";
import { appendJournal } from "./journal-store";
import { runTimeline } from "./timeline";
import type { AgentRunView } from "./types";

interface RunState {
  id: string;
  vault: string;
  role: string;
  model: string | null;
  status: "running" | "finished" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  entries: JournalEntry[];
  /** Account whose sequence number the run consumes. */
  source: string;
}

/** Latest run per vault, kept in memory for polling. */
const runs = new Map<string, RunState>();
/** Accounts with a run in flight: two runs sharing a key would race its sequence number. */
const busy = new Set<string>();

const view = (run: RunState): AgentRunView => ({
  id: run.id,
  vault: run.vault,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  role: run.role,
  model: run.model,
  error: run.error,
  items: runTimeline(run.id, run.role, run.entries).reverse(),
});

export function latestRun(vault: string): AgentRunView | null {
  const run = runs.get(vault);
  return run ? view(run) : null;
}

/**
 * Reserves a run of `vault`'s agent: its own strategy and default role, the
 * session key from the server environment. Refuses while a run holding the
 * same key is in flight. The returned task performs the run.
 */
export function prepareRun(vault: string, signalsBaseUrl: string): { run: AgentRunView; task: () => Promise<void> } {
  if (!process.env.OPENAI_API_KEY) throw new ApiError("The agent's model is not configured on this server.", 503);
  const target = resolveVault(vault, knownVaults(fleet));
  if (!target.strategyId) throw new ApiError("This vault has no strategy the agent runtime knows.", 400);
  const role = STRATEGIES[target.strategyId].role;
  let keys;
  try {
    keys = resolveKeys(target, role);
  } catch {
    throw new ApiError("This server does not hold the session key of this vault's agent.", 403);
  }
  const source = (keys.feePayer ?? keys.member).publicKey();
  if (runs.get(vault)?.status === "running") throw new ApiError("The agent is already running on this vault.", 409);
  if (busy.has(source)) throw new ApiError("Another vault's agent is using the same session key right now. Try again in a minute.", 409);
  busy.add(source);

  const signals = keys.member.publicKey() === fleet.agent ? signalOptions(signalsBaseUrl, keys.member) : undefined;
  const run: RunState = {
    id: randomUUID(), vault, role, model: process.env.OPENAI_MODEL || null, status: "running",
    startedAt: new Date().toISOString(), finishedAt: null, error: null, entries: [], source,
  };
  runs.set(vault, run);
  const record = (status: RunState["status"], error?: string) =>
    appendJournal({ type: "run", runId: run.id, vault, status, role, model: run.model, at: new Date().toISOString(), ...(error ? { error } : {}) })
      .catch((reason: unknown) => console.error("agent journal:", reason instanceof Error ? reason.message : reason));
  void record("running");

  const task = async () => {
    try {
      const result = await runAgent({
        vault, deployments: fleet, leash: leash(), keys, ...(signals ? { signals } : {}),
        onEntry: entry => {
          run.entries.push(entry);
          appendJournal({ type: "entry", runId: run.id, vault, entry })
            .catch((reason: unknown) => console.error("agent journal:", reason instanceof Error ? reason.message : reason));
        },
      });
      run.model = result.model;
      run.status = "finished";
      await record("finished");
    } catch (error) {
      // Model and RPC failures are shown as text; vault refusals are journal entries, not errors.
      run.status = "failed";
      run.error = error instanceof Error ? error.message.slice(0, 300) : "The run stopped unexpectedly.";
      await record("failed", run.error);
    } finally {
      run.finishedAt = new Date().toISOString();
      busy.delete(source);
      for (const key of [`vault:${vault}`, `activity:${vault}`, "agents", "events"]) invalidate(key);
    }
  };
  return { run: view(run), task };
}
