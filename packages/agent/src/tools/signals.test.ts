import { encodePaymentRequiredHeader } from "@x402/core/http";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { expiryLedger, payableRequirements, paymentProtocol } from "./signals.js";

const USDC = "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
const PAY_TO = "GC3ZQQ23T23WOLCCYNFZ3TG3OZHF6KWIAO2WBP6LS3YQZEFWE4C2RINQ";
const offer: PaymentRequirements = {
  scheme: "exact", network: "stellar:testnet", asset: USDC, amount: "20000000", payTo: PAY_TO,
  maxTimeoutSeconds: 60, extra: { areFeesSponsored: true },
};
const paymentRequired: PaymentRequired = {
  x402Version: 2, resource: { url: "http://localhost/api/signals/rates" }, accepts: [offer],
};

describe("paymentProtocol", () => {
  it("recognizes an x402 challenge from its PAYMENT-REQUIRED header", () => {
    const response = new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) } });
    expect(paymentProtocol(response)).toBe("x402");
  });

  it("recognizes an MPP challenge from its Payment authentication scheme", () => {
    const response = new Response(null, { status: 402, headers: { "WWW-Authenticate": 'Payment id="abc", method="stellar", intent="charge"' } });
    expect(paymentProtocol(response)).toBe("mpp");
  });

  it("ignores responses that are not payment challenges", () => {
    expect(paymentProtocol(new Response(null, { status: 200 }))).toBeNull();
    expect(paymentProtocol(new Response(null, { status: 402, headers: { "WWW-Authenticate": "Bearer" } }))).toBeNull();
  });
});

describe("x402 payment requirements", () => {
  it("decodes the 402 header into the offer the budget can pay", () => {
    const response = new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) } });
    const decoded = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(name => response.headers.get(name));
    expect(payableRequirements(decoded.accepts, USDC, 20_000_000n)).toEqual([offer]);
  });

  it("drops offers above the price cap, in another asset, network or without sponsored fees", () => {
    const offers: PaymentRequirements[] = [
      { ...offer, amount: "20000001" },
      { ...offer, asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
      { ...offer, network: "stellar:pubnet" },
      { ...offer, extra: {} },
      { ...offer, amount: "0" },
    ];
    expect(payableRequirements(offers, USDC, 20_000_000n)).toEqual([]);
  });
});

describe("expiryLedger", () => {
  it("converts the payment deadline into ledgers of five seconds", () => {
    expect(expiryLedger(1_000, 100, 160)).toBe(1_012);
    expect(expiryLedger(1_000, 100, 161)).toBe(1_013);
  });

  it("always leaves at least one ledger", () => {
    expect(expiryLedger(1_000, 100, 90)).toBe(1_001);
  });
});
