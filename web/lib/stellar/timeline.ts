import { describeError, type ErrorSource } from "@leash/sdk";
import type { JournalEntry } from "@leash/agent";
import type { VaultEvent } from "./chain-events";
import type { JournalRecord } from "./journal-store";
import type { TimelineAction, TimelineItem, TimelineNote, TypedError } from "./types";

/** A refused vault call found on-chain (FAILED transaction), with its decoded error. */
export interface FailedAttempt {
  hash: string;
  at: string;
  role: string;
  target: string;
  fn: string;
  error: TypedError | null;
}

const RUNTIME_ERROR = /^(\w+) \((\w+) #(\d+)\)$/;
const SOURCES: Record<string, true> = { vault: true, registry: true, oracle: true, factory: true, signal_budget: true, other: true };

/** The typed error of a runtime journal string such as `CallNotAllowed (vault #1)`. */
export function parseRuntimeError(text: string | undefined): TypedError | null {
  if (!text) return null;
  const match = RUNTIME_ERROR.exec(text);
  if (!match) return { contract: "other", code: 0, name: text, message: text };
  const [, name = "", contract = "other", code = "0"] = match;
  const source = (SOURCES[contract] ? contract : "other") as ErrorSource;
  const described = describeError(source, Number(code));
  return described.name === name
    ? described
    : { contract: source, code: Number(code), name, message: name === "AuthFailed" ? "An authorization was missing or its signature did not verify." : `${name} (${contract} #${code}).` };
}

const TOOL_LABELS: Record<string, string> = {
  read_rates: "Read live rates",
  read_positions: "Read positions and limits",
  read_prices: "Read oracle prices",
  fetch_market_news: "Read market news",
  buy_signal: "Bought a paid signal",
};

const navAfterOf = (output: string | undefined) => /navAfter=([\d.]+) USDC/.exec(output ?? "")?.[1] ?? null;

/** Converts a decimal USDC string from the runtime (`123.4567`) into base units. */
function usdcUnits(value: string | null): string | null {
  if (!value) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return (BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7) || "0")).toString();
}

/**
 * Timeline of one agent run from its journal: each proposal becomes an action
 * that went proposed → simulated → authorized/blocked (one item per submitted
 * call), simulations never followed by a proposal stay "simulated only", and
 * reads, payments and model messages become notes.
 */
export function runTimeline(runId: string, role: string, entries: JournalEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  /** Latest simulation per action label, waiting for its proposal. */
  const simulations = new Map<string, TimelineAction>();
  /** Simulations folded into the proposal that followed them. */
  const folded = new Set<TimelineAction>();
  entries.forEach((entry, index) => {
    const id = `${runId}:${index}`;
    if (entry.kind === "model") {
      if (entry.text?.trim()) {
        items.push({ type: "note", id, at: entry.at, runId, tool: null, text: entry.text.trim(), detail: null, hash: null, failed: false });
      }
      return;
    }
    const tool = entry.tool ?? "";
    const label = entry.input ?? tool;
    if (tool === "simulate" || tool === "propose_execute") {
      const rejected = entry.error ? entry.error.replace(/^rejected: /, "") : null;
      const base: TimelineAction = {
        type: "action", id, at: entry.at, source: "run", runId, role, label, proposed: tool === "propose_execute",
        simulation: null, outcome: "rejected", error: null, reason: rejected, hash: null, navBefore: null, navAfter: null,
      };
      if (rejected) {
        items.push(base);
        return;
      }
      if (tool === "simulate") {
        const failed = entry.simulation?.find(result => !result.ok);
        const item: TimelineAction = {
          ...base, outcome: "simulated-only",
          simulation: { ok: !failed, error: failed ? parseRuntimeError(failed.error) : null },
          navBefore: entry.simulation?.[0]?.navBefore ?? null,
        };
        simulations.set(label, item);
        items.push(item);
        return;
      }
      const simulated = simulations.get(label);
      if (simulated) {
        // The simulation becomes the "simulated" stage of this proposal.
        folded.add(simulated);
        simulations.delete(label);
      }
      const txs = entry.tx ?? [];
      const navAfter = usdcUnits(navAfterOf(entry.output));
      txs.forEach((tx, call) => {
        items.push({
          ...base,
          id: `${id}:${call}`,
          label: txs.length > 1 ? `${label} (call ${call + 1} of ${txs.length})` : label,
          simulation: simulated?.simulation ?? null,
          navBefore: simulated?.navBefore ?? null,
          navAfter: tx.status === "SUCCESS" && call === txs.length - 1 ? navAfter : null,
          outcome: tx.status === "SUCCESS" ? "authorized" : "blocked",
          error: tx.status === "SUCCESS" ? null : parseRuntimeError(tx.error),
          reason: null,
          hash: tx.hash,
        });
      });
      return;
    }
    const tx = entry.tx?.[0];
    const note: TimelineNote = {
      type: "note", id, at: entry.at, runId, tool,
      text: TOOL_LABELS[tool] ?? tool,
      detail: entry.error ?? entry.output ?? entry.input ?? null,
      hash: tx?.hash ?? null,
      failed: Boolean(entry.error) || tx?.status === "FAILED",
    };
    if (tool === "buy_signal") note.text = tx?.status === "FAILED" ? `Signal payment refused (${entry.input ?? "signal"})` : `Bought a paid ${entry.input ?? ""} signal`.replace("  ", " ");
    items.push(note);
  });
  return items.filter(item => item.type !== "action" || !folded.has(item));
}

/**
 * Merges the app's run journal with what the chain shows for a vault: vault
 * events (authorized calls, deposits, withdrawals) and FAILED vault calls.
 * Chain items already covered by a journal entry (same hash) only enrich it.
 * Newest first.
 */
export function mergeTimeline(opts: {
  journal: JournalRecord[];
  events: VaultEvent[];
  failed: FailedAttempt[];
  name: (contract: string) => string;
}): TimelineItem[] {
  const runs = new Map<string, { role: string; entries: JournalEntry[] }>();
  const items: TimelineItem[] = [];
  for (const record of opts.journal) {
    if (record.type === "run") {
      const run = runs.get(record.runId) ?? { role: record.role, entries: [] };
      runs.set(record.runId, run);
      const existing = items.findIndex(item => item.type === "run" && item.runId === record.runId);
      const marker: TimelineItem = {
        type: "run", id: `run:${record.runId}`, at: existing >= 0 ? (items[existing] as TimelineItem).at : record.at,
        runId: record.runId, status: record.status, role: record.role, model: record.model, error: record.error ?? null,
      };
      if (existing >= 0) items[existing] = marker;
      else items.push(marker);
    } else {
      const run = runs.get(record.runId) ?? { role: "default", entries: [] };
      run.entries.push(record.entry);
      runs.set(record.runId, run);
    }
  }
  for (const [runId, run] of runs) items.push(...runTimeline(runId, run.role, run.entries));

  const byHash = new Map<string, TimelineAction>();
  for (const item of items) if (item.type === "action" && item.hash) byHash.set(item.hash, item);

  for (const event of opts.events) {
    if (event.kind === "executed") {
      const known = byHash.get(event.hash);
      if (known) {
        known.navBefore = event.navBefore;
        known.navAfter = event.navAfter;
        continue;
      }
      items.push({
        type: "action", id: `event:${event.hash}:${event.fn}`, at: event.at, source: "chain", runId: null, role: event.role,
        label: `${opts.name(event.target)} · ${event.fn}`, proposed: true, simulation: null, outcome: "authorized",
        error: null, reason: null, hash: event.hash, navBefore: event.navBefore, navAfter: event.navAfter,
      });
    } else {
      items.push({
        type: event.kind === "deposited" ? "deposit" : "withdraw", id: `event:${event.hash}:${event.kind}`, at: event.at,
        user: event.user, amount: event.amount, shares: event.shares, hash: event.hash,
      });
    }
  }
  for (const attempt of opts.failed) {
    const known = byHash.get(attempt.hash);
    if (known) {
      known.error ??= attempt.error;
      continue;
    }
    items.push({
      type: "action", id: `failed:${attempt.hash}`, at: attempt.at, source: "chain", runId: null, role: attempt.role,
      label: `${opts.name(attempt.target)} · ${attempt.fn}`, proposed: true, simulation: null, outcome: "blocked",
      error: attempt.error, reason: null, hash: attempt.hash, navBefore: null, navAfter: null,
    });
  }
  // Newest first; entries of one run keep their order when timestamps tie.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.at.localeCompare(a.item.at) || b.index - a.index)
    .map(({ item }) => item);
}
