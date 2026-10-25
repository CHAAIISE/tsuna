import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { stellar } from "./config";
import {
  assertForwarderMessage, buildForwarderHookData, cctpToStellarAmount, contractStrkeyToBytes32, decodeBurnMessage,
  decodeForwarderHookData, maxFeeFor, mintedOnStellar, type Hex,
} from "./encoding";
import { formatUsdc } from "./format";

const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const forwarderBytes = contractStrkeyToBytes32(stellar.cctpForwarder);

describe("buildForwarderHookData", () => {
  it("writes 24 zero bytes, version 0 and the length as big-endian u32, then the strkey", () => {
    const bytes = Buffer.from(buildForwarderHookData(recipient).slice(2), "hex");
    expect(bytes.length).toBe(32 + 56);
    expect([...bytes.subarray(0, 24)]).toEqual(Array(24).fill(0));
    expect([...bytes.subarray(24, 28)]).toEqual([0, 0, 0, 0]);
    expect([...bytes.subarray(28, 32)]).toEqual([0, 0, 0, 56]);
    expect(bytes.subarray(32).toString("utf8")).toBe(recipient);
  });

  it("round-trips through the decoder", () => {
    expect(decodeForwarderHookData(buildForwarderHookData(recipient))).toBe(recipient);
    expect(decodeForwarderHookData(buildForwarderHookData(stellar.cctpForwarder))).toBe(stellar.cctpForwarder);
  });

  it("rejects recipients that are not valid Stellar strkeys", () => {
    const typo = `${recipient.slice(0, -1)}${recipient.endsWith("A") ? "B" : "A"}`;
    for (const bad of [typo, recipient.toLowerCase(), "0x23b533aA4a8d1d13739644d8eA2029B1cf00685E", "", `S${recipient.slice(1)}`]) {
      expect(() => buildForwarderHookData(bad)).toThrow(/Invalid Stellar recipient/);
    }
  });
});

describe("contractStrkeyToBytes32", () => {
  it("decodes the forwarder to its raw 32-byte id", () => {
    expect(forwarderBytes).toMatch(/^0x[0-9a-f]{64}$/);
    expect(StrKey.encodeContract(Buffer.from(forwarderBytes.slice(2), "hex"))).toBe(stellar.cctpForwarder);
  });

  it("refuses account strkeys", () => {
    expect(() => contractStrkeyToBytes32(recipient)).toThrow(/Invalid contract strkey/);
  });
});

describe("amounts", () => {
  it("scales six-decimal CCTP amounts to seven-decimal Stellar units", () => {
    expect(cctpToStellarAmount(1_000_000n)).toBe(10_000_000n);
    expect(cctpToStellarAmount(123_456n)).toBe(1_234_560n);
    expect(cctpToStellarAmount(0n)).toBe(0n);
    expect(() => cctpToStellarAmount(-1n)).toThrow();
  });

  it("rounds the Iris fee budget up", () => {
    expect(maxFeeFor(1_000_000n, 1)).toBe(100n);
    expect(maxFeeFor(1_000_001n, 1)).toBe(101n);
    expect(maxFeeFor(1_000_000n, 1.3)).toBe(130n);
    expect(maxFeeFor(1_000_000n, 0)).toBe(0n);
  });

  it("formats both precisions without floats", () => {
    expect(formatUsdc(9_999_000n, 7)).toBe("0.9999");
    expect(formatUsdc(1_000_000n, 6)).toBe("1");
  });
});

function word(value: bigint | number): Buffer {
  return Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function burnMessage(hookData: Hex, mintRecipient: Hex = forwarderBytes): Hex {
  const raw = (hex: Hex) => Buffer.from(hex.slice(2), "hex");
  const header = Buffer.concat([
    u32(1), u32(0), u32(27), Buffer.alloc(32, 9), Buffer.alloc(32, 1), Buffer.alloc(32, 2), raw(forwarderBytes), u32(1000), u32(1000),
  ]);
  const body = Buffer.concat([
    u32(1), Buffer.alloc(32, 3), raw(mintRecipient), word(1_000_000), Buffer.alloc(32, 4), word(100), word(100), word(0), raw(hookData),
  ]);
  return `0x${Buffer.concat([header, body]).toString("hex")}`;
}

describe("decodeBurnMessage", () => {
  it("reads the six-decimal amount and fee and predicts the Stellar mint", () => {
    const message = decodeBurnMessage(burnMessage(buildForwarderHookData(recipient)));
    expect(message).toMatchObject({ sourceDomain: 0, destinationDomain: 27, amount: 1_000_000n, maxFee: 100n, feeExecuted: 100n });
    expect(() => assertForwarderMessage(message, recipient)).not.toThrow();
    expect(mintedOnStellar(message)).toBe(9_999_000n);
  });

  it("refuses messages that bypass the forwarder or pay someone else", () => {
    const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
    const direct = decodeBurnMessage(burnMessage(buildForwarderHookData(recipient), `0x${"11".repeat(32)}`));
    expect(() => assertForwarderMessage(direct, recipient)).toThrow(/forwarder/);
    const elsewhere = decodeBurnMessage(burnMessage(buildForwarderHookData(other)));
    expect(() => assertForwarderMessage(elsewhere, recipient)).toThrow(/expected/);
  });
});
