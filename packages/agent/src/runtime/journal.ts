/** Outcome of one simulated vault call. */
export interface JournalSimulation {
  ok: boolean;
  /** Typed vault/registry/oracle error name when the simulation is refused. */
  error?: string;
  /** NAV before the call (base units), when the simulation reports it. */
  navBefore?: string;
}

/** One submitted vault call. */
export interface JournalTx {
  hash: string;
  status: "SUCCESS" | "FAILED";
  /** Typed error name of a FAILED transaction. */
  error?: string;
  ledger?: number;
}

export interface JournalEntry {
  /** Zero-based model step the entry belongs to. */
  step: number;
  at: string;
  kind: "tool" | "model";
  tool?: string;
  /** Short summary of the tool input. */
  input?: string;
  /** Short summary of the tool output. */
  output?: string;
  simulation?: JournalSimulation[];
  tx?: JournalTx[];
  /** Model text of the step. */
  text?: string;
  error?: string;
}

/** Collects the journal of one run and forwards each entry as it is written. */
export class Journal {
  readonly entries: JournalEntry[] = [];
  step = 0;

  constructor(private readonly onEntry?: (entry: JournalEntry) => void) {}

  add(entry: Omit<JournalEntry, "step" | "at">): JournalEntry {
    const full: JournalEntry = { step: this.step, at: new Date().toISOString(), ...entry };
    this.entries.push(full);
    this.onEntry?.(full);
    return full;
  }
}

/** One JSON object per line; bigint values are written as decimal strings. */
export function formatJournalLine(entry: JournalEntry): string {
  return JSON.stringify(entry, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
}

export function formatJournal(entries: readonly JournalEntry[]): string {
  return entries.map(formatJournalLine).join("\n");
}
