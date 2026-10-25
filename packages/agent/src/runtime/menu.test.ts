import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fromUnits, toUnits } from "./amounts.js";
import { ACTION_DOCS, ACTION_NAMES, describeAction, proposalSchema, validateProposal, type Menu } from "./menu.js";
import { STRATEGIES } from "./strategies.js";

const prudent = STRATEGIES.prudent.menu;
const OUTSIDER = Keypair.random().publicKey();

describe("amounts", () => {
  it("converts decimal token amounts to 7-decimal base units and back", () => {
    expect(toUnits("25")).toBe(250_000_000n);
    expect(toUnits("0.0000001")).toBe(1n);
    expect(toUnits("12.5")).toBe(125_000_000n);
    expect(fromUnits(125_000_000n)).toBe("12.5");
    expect(fromUnits(-10_000_000n)).toBe("-1");
    expect(() => toUnits("1e3")).toThrow(/Invalid amount/);
    expect(() => toUnits("0.00000001")).toThrow(/Invalid amount/);
  });
});

describe("proposal schema", () => {
  it("offers exactly the strategy menu to the model", () => {
    expect(z.toJSONSchema(proposalSchema(prudent))).toMatchObject({
      type: "object",
      properties: { action: { enum: [...prudent] }, amount: { type: "string" } },
      required: expect.arrayContaining(["action", "amount"]),
    });
  });

  it("documents every action", () => {
    for (const name of ACTION_NAMES) expect(ACTION_DOCS[name]).toMatch(new RegExp(`^${name} `));
  });
});

describe("validateProposal", () => {
  it("accepts a well-formed action and converts its amount", () => {
    const result = validateProposal(prudent, { action: "blend_supply", asset: "USDC", amount: "40" });
    expect(result).toEqual({ ok: true, action: { action: "blend_supply", asset: "USDC", amount: 400_000_000n } });
    if (result.ok) expect(describeAction(result.action)).toBe("blend_supply 40 USDC");
  });

  it("rejects an action outside the strategy menu and an unknown action", () => {
    expect(validateProposal(prudent, { action: "soroswap_swap", asset: "USDC", amount: "1" }).ok).toBe(false);
    expect(validateProposal(prudent, { action: "flash_loan", amount: "1" }).ok).toBe(false);
  });

  it("rejects zero, negative and malformed amounts", () => {
    for (const amount of ["0", "0.0000000", "-5", "abc", "1,5", ""]) {
      const result = validateProposal(prudent, { action: "defindex_deposit", amount });
      expect(result.ok, amount).toBe(false);
    }
    expect(validateProposal(prudent, { action: "defindex_deposit", amount: "0" })).toEqual({ ok: false, reason: "amount must be greater than 0" });
  });

  it("requires the fields each action needs", () => {
    expect(validateProposal(prudent, { action: "blend_supply", amount: "1" })).toEqual({ ok: false, reason: "asset is required" });
    const liquidity: Menu = STRATEGIES.liquidity.menu;
    expect(validateProposal(liquidity, { action: "aquarius_deposit", amount: "1" })).toEqual({ ok: false, reason: "amountXlm is required" });
    expect(validateProposal(prudent, { action: "usdc_transfer", amount: "1", to: "not-an-address" }).ok).toBe(false);
  });

  it("lets a transfer to any valid address through: the vault, not the runtime, refuses it", () => {
    expect(validateProposal(prudent, { action: "usdc_transfer", amount: "100", to: OUTSIDER }))
      .toEqual({ ok: true, action: { action: "usdc_transfer", to: OUTSIDER, amount: 1_000_000_000n } });
  });
});
