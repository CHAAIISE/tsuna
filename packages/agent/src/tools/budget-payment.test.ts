import { Address, Keypair, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SESSION_RULE_ID, sessionAuthPayload } from "./budget-payment.js";

const budget = {
  account: "CBAS4QRJL6MSOWSC44XVQWZ7JW7Q5XRHVQ4SX4AGVD5VJPQHBVHD5CFN",
  verifier: "CATM5LOHXN7CPSAA4AYLRSI2RY2TIWIZOJFYLGOHP2H5AYOUQR2R4JLW",
  sessionKey: Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7)),
};

describe("sessionAuthPayload", () => {
  it("signs the OZ auth digest with the session key under the session rule", () => {
    const signaturePayload = new Uint8Array(32).fill(42);
    const payload = sessionAuthPayload(budget, signaturePayload);
    if (payload.type !== "scvMap" || !payload.map) throw new Error("AuthPayload must be a map");
    expect(payload.map.map(entry => scValToNative(entry.key))).toEqual(["context_rule_ids", "signers"]);
    const [ruleIds, signers] = payload.map.map(entry => entry.val);
    expect(scValToNative(ruleIds as xdr.ScVal)).toEqual([SESSION_RULE_ID]);
    if (signers?.type !== "scvMap" || signers.map?.length !== 1) throw new Error("Expected a single signer");
    const [{ key, val }] = signers.map as [xdr.ScMapEntry];
    expect(scValToNative(key)).toEqual(["External", budget.verifier, budget.sessionKey.rawPublicKey()]);
    const digest = hash(xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("account"), val: new Address(budget.account).toScVal() }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(SESSION_RULE_ID)]) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature_payload"), val: xdr.ScVal.scvBytes(signaturePayload) }),
    ]).toXdr());
    expect(budget.sessionKey.verify(digest, scValToNative(val) as Uint8Array)).toBe(true);
  });
});
