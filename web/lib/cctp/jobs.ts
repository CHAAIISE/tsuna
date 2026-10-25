import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialSteps, type BridgeResult, type BridgeStep } from "#cctp/bridge";

export interface BridgeJob {
  id: string;
  status: "running" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
  /** Six-decimal USDC burned on Sepolia. */
  amount: string;
  recipient: string;
  vault: string;
  steps: BridgeStep[];
  result?: BridgeResult;
  error?: string;
}

/** Jobs live in one JSON file per server instance; only the most recent ones are kept. */
const STORE = join(tmpdir(), "leash-bridge-jobs.json");
const MAX_JOBS = 20;
/** A run that has not reported for this long died with its process. */
const STALE_MS = 35 * 60_000;

let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<BridgeJob[]> {
  try {
    const jobs = JSON.parse(await readFile(STORE, "utf8")) as BridgeJob[];
    const now = Date.now();
    return jobs.map(job => job.status === "running" && now - Date.parse(job.updatedAt) > STALE_MS
      ? { ...job, status: "failed", error: "The server stopped before this bridge finished" }
      : job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function save(jobs: BridgeJob[]): Promise<void> {
  const temporary = `${STORE}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(jobs.slice(0, MAX_JOBS)));
  await rename(temporary, STORE);
}

/** Serialises read-modify-write cycles within this process. */
function mutate<T>(change: (jobs: BridgeJob[]) => T): Promise<T> {
  const next = queue.then(async () => {
    const jobs = await load();
    const value = change(jobs);
    await save(jobs);
    return value;
  });
  queue = next.catch(() => undefined);
  return next;
}

export async function getJob(id?: string): Promise<BridgeJob | null> {
  await queue;
  const jobs = await load();
  return (id ? jobs.find(job => job.id === id) : jobs[0]) ?? null;
}

/** Creates a job unless one is already running: a single test wallet burns, one bridge at a time. */
export function createJob(input: Pick<BridgeJob, "amount" | "recipient" | "vault">): Promise<BridgeJob | null> {
  return mutate(jobs => {
    if (jobs.some(job => job.status === "running")) return null;
    const now = new Date().toISOString();
    const job: BridgeJob = { id: randomUUID(), status: "running", createdAt: now, updatedAt: now, ...input, steps: initialSteps() };
    jobs.unshift(job);
    return job;
  });
}

export function updateJob(id: string, patch: Partial<Pick<BridgeJob, "status" | "steps" | "result" | "error">>): Promise<void> {
  return mutate(jobs => {
    const job = jobs.find(entry => entry.id === id);
    if (job) Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  });
}
