import type { Attack, AttackResult } from "@leash/agent";

export interface AttackRun {
  id: string;
  attack: string;
  status: "running" | "finished" | "failed";
  result: AttackResult | null;
  error: string | null;
}

export interface ProtocolWatch {
  protocol: string;
  name: string;
  pinned: string | null;
  current: string | null;
  halted: boolean;
}

export interface AttackCatalog {
  attacks: Attack[];
  runs: AttackRun[];
}
