import type { JournalEntry } from "@tsuna/agent";
import { describe, expect, it } from "vitest";
import { mergeTimeline, parseRuntimeError, runTimeline } from "./timeline";
import type { TimelineAction } from "./types";

const at = (minute: number) => `2026-10-25T21:${String(minute).padStart(2, "0")}:00.000Z`;
const entry = (minute: number, fields: Partial<JournalEntry>): JournalEntry => ({ step: 0, at: at(minute), kind: "tool", ...fields });

describe("runtime errors", () => {
  it("names the vault error the runtime journaled", () => {
    expect(parseRuntimeError("CallNotAllowed (vault #1)")).toMatchObject({ name: "CallNotAllowed", contract: "vault", code: 1, message: expect.stringContaining("allowlist") });
    expect(parseRuntimeError(undefined)).toBeNull();
  });
});

describe("run timeline", () => {
  const entries: JournalEntry[] = [
    entry(1, { tool: "read_rates", output: "{}" }),
    entry(2, { tool: "simulate", input: "blend_supply 100 USDC", simulation: [{ ok: true, navBefore: "3000000000" }] }),
    entry(3, { tool: "propose_execute", input: "blend_supply 100 USDC", tx: [{ hash: "aa", status: "SUCCESS" }], output: "navAfter=300.0000001 USDC" }),
    entry(4, { tool: "propose_execute", input: "usdc_transfer 5 USDC to GATTACKER", tx: [{ hash: "bb", status: "FAILED", error: "CallNotAllowed (vault #1)" }] }),
    entry(5, { tool: "simulate", input: "defindex_deposit 1 USDC", simulation: [{ ok: false, error: "ExposureCapExceeded (vault #23)" }] }),
    entry(6, { tool: "propose_execute", input: "blend_borrow 1 USDC", error: "rejected: not in this strategy's menu" }),
    entry(7, { kind: "model", text: "Supplied idle USDC to Blend." }),
  ];
  const items = runTimeline("run-1", "default", entries);
  const actions = items.filter((item): item is TimelineAction => item.type === "action");

  it("folds a simulation into the proposal that follows it", () => {
    expect(actions.map(action => [action.label, action.outcome])).toEqual([
      ["blend_supply 100 USDC", "authorized"],
      ["usdc_transfer 5 USDC to GATTACKER", "blocked"],
      ["defindex_deposit 1 USDC", "simulated-only"],
      ["blend_borrow 1 USDC", "rejected"],
    ]);
    expect(actions[0]).toMatchObject({ proposed: true, simulation: { ok: true, error: null }, hash: "aa", navBefore: "3000000000", navAfter: "3000000001" });
  });

  it("keeps the typed error of a blocked call and of a refused simulation", () => {
    expect(actions[1]?.error?.name).toBe("CallNotAllowed");
    expect(actions[2]?.simulation).toMatchObject({ ok: false, error: { name: "ExposureCapExceeded" } });
    expect(actions[3]?.reason).toBe("not in this strategy's menu");
  });

  it("turns reads and model text into notes", () => {
    expect(items.filter(item => item.type === "note").map(note => note.type === "note" && note.text)).toEqual(["Read live rates", "Supplied idle USDC to Blend."]);
  });
});

describe("merged timeline", () => {
  it("enriches journal entries with chain data and adds what only the chain saw, newest first", () => {
    const items = mergeTimeline({
      journal: [
        { type: "run", runId: "r", vault: "V", status: "running", role: "default", model: null, at: at(1) },
        { type: "entry", runId: "r", vault: "V", entry: entry(2, { tool: "propose_execute", input: "blend_supply 1 USDC", tx: [{ hash: "aa", status: "SUCCESS" }] }) },
        { type: "run", runId: "r", vault: "V", status: "finished", role: "default", model: "m", at: at(3) },
      ],
      events: [
        { kind: "executed", vault: "V", role: "default", target: "B", fn: "submit", navBefore: "10", navAfter: "11", hash: "aa", at: at(2), ledger: 1 },
        { kind: "deposited", vault: "V", user: "U", amount: "5", shares: "50", hash: "dd", at: at(0), ledger: 0 },
      ],
      failed: [
        { hash: "ff", signer: "S", at: at(4), role: "default", target: "B", fn: "submit", error: { contract: "vault", code: 2, name: "DestinationNotVault", message: "m" } },
        { hash: "ee", signer: "A", at: at(5), role: "default", target: "B", fn: "submit", error: { contract: "vault", code: 2, name: "DestinationNotVault", message: "m" } },
      ],
      name: () => "Blend",
      attacker: "A",
    });
    expect(items.map(item => item.type === "action" ? `${item.outcome}:${item.hash}` : item.type)).toEqual(["blocked:ee", "blocked:ff", "authorized:aa", "run", "deposit"]);
    expect(items[2]).toMatchObject({ navBefore: "10", navAfter: "11", source: "run" });
    expect(items[3]).toMatchObject({ status: "finished", at: at(1) });
    // Calls seen only on-chain were never proposed or simulated by a journaled run, and the attacker's are not the agent's.
    expect(items[0]).toMatchObject({ source: "attack", proposed: false });
    expect(items[1]).toMatchObject({ label: "Blend · submit", source: "chain", proposed: false });
  });
});
