/**
 * JSON shapes of `/api/crash`. Contract integers travel as decimal strings: prices and amounts
 * in 7-decimal units, health factors in bps.
 */
import type { TimelineItem, TypedError } from "@/lib/stellar/types";

/** Steps of the guided crash, in order; `restore` may also run early to stop the scenario. */
export const CRASH_STEP_IDS = ["prepare", "crash", "yield-refused", "pause", "riskoff-refused", "riskoff-repay", "withdraw", "restore"] as const;
export type CrashStepId = (typeof CRASH_STEP_IDS)[number];

export const isCrashStep = (value: unknown): value is CrashStepId =>
  typeof value === "string" && (CRASH_STEP_IDS as readonly string[]).includes(value);

export interface CrashTxView {
  label: string;
  hash: string;
  status: "SUCCESS" | "FAILED";
  error: TypedError | null;
}

export interface CrashStepView {
  id: CrashStepId;
  status: "done" | "failed";
  at: string;
  txs: CrashTxView[];
  /** Facts read back from the chain after the step. */
  notes: string[];
  /** Why the step stopped, when it failed. */
  error: string | null;
}

export interface CrashRunView {
  id: string;
  startedAt: string;
  /** Step running on the server right now. */
  busy: CrashStepId | null;
  /** Next step of the guided flow; `null` once a restore ran. */
  next: CrashStepId | null;
  /** Latest outcome of each step that ran. */
  steps: CrashStepView[];
  /** The demo price or the pause set by this run is still in place. */
  needsRestore: boolean;
  /** The server restored the vault on its own after the run sat idle. */
  autoRestored: boolean;
  /** Journal of the risk-off agent's run, live while it thinks. */
  journal: TimelineItem[];
}

export interface CrashLiveView {
  demo: boolean;
  forcedPrice: string | null;
  xlmPrice: string | null;
  healthFactorBps: string | null;
  minHealthBps: number;
  maxDrawdownBps: number;
  nav: string | null;
  pps: string | null;
  paused: boolean;
  debt: string | null;
  asOf: string;
}

export interface CrashResponse {
  /** The vault the crash scenario runs on; `null` when the requested vault is another one. */
  vault: { id: string; address: string; name: string } | null;
  /** Why this server cannot run the scenario (missing keys), if so. */
  unavailable: string | null;
  live: CrashLiveView | null;
  liveError: string | null;
  run: CrashRunView | null;
}
