import "server-only";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JournalEntry } from "@leash/agent";

/**
 * Append-only journal of the agent runs started from the app. A refused vault
 * call reverts with its events, so the chain keeps only the FAILED transaction:
 * this file keeps what the agent proposed and simulated around it.
 */
export type JournalRecord =
  | { type: "run"; runId: string; vault: string; status: "running" | "finished" | "failed"; role: string; model: string | null; at: string; error?: string }
  | { type: "entry"; runId: string; vault: string; entry: JournalEntry };

const configured = process.env.LEASH_JOURNAL_FILE;
let file = configured || path.join(/*turbopackIgnore: true*/ process.cwd(), ".leash", "agent-journal.jsonl");
let queue: Promise<unknown> = Promise.resolve();

async function write(line: string): Promise<void> {
  try {
    await mkdir(/*turbopackIgnore: true*/ path.dirname(file), { recursive: true });
    await appendFile(/*turbopackIgnore: true*/ file, line);
  } catch (error) {
    // Read-only deployments (serverless) still have a writable temp directory.
    if (configured || file.startsWith(tmpdir())) throw error;
    file = path.join(tmpdir(), "leash-agent-journal.jsonl");
    await appendFile(/*turbopackIgnore: true*/ file, line);
  }
}

/** Appends `record` as one JSON line, in call order. */
export function appendJournal(record: JournalRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const next = queue.then(() => write(line));
  queue = next.catch(() => undefined);
  return next;
}

/** Every record of `vault`, oldest first; an absent file is an empty journal. */
export async function readJournal(vault: string): Promise<JournalRecord[]> {
  await queue;
  let content: string;
  try {
    content = await readFile(/*turbopackIgnore: true*/ file, "utf8");
  } catch {
    return [];
  }
  const records: JournalRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as JournalRecord;
      if (record.vault === vault) records.push(record);
    } catch {
      // A torn last line (crash mid-write) is skipped, not fatal.
    }
  }
  return records;
}
