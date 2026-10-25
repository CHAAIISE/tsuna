import { describe, expect, it } from "vitest";
import { policyRefusal, policyRefusalFromCodes } from "./refusal.js";

describe("policyRefusal", () => {
  it("maps the spending limit error in a simulation failure", () => {
    const error = 'HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CCQR…, topics:[error, Error(Contract, #3221)], data:"escalating error to panic"';
    expect(policyRefusal(error)).toEqual({ name: "SpendingLimitExceeded", code: 3221 });
  });

  it("skips contract errors that do not come from the spending limit policy", () => {
    expect(policyRefusal("Error(Contract, #2) then Error(Contract, #3226)")).toEqual({ name: "LessThanZero", code: 3226 });
    expect(policyRefusal("Error(Contract, #1)")).toBeUndefined();
    expect(policyRefusal("Error(Auth, InvalidAction)")).toBeUndefined();
  });

  it("maps on-chain diagnostic codes", () => {
    expect(policyRefusalFromCodes([10, 3221])).toEqual({ name: "SpendingLimitExceeded", code: 3221 });
    expect(policyRefusalFromCodes([])).toBeUndefined();
  });
});
