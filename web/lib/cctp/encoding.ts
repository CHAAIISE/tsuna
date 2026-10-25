import { StrKey } from "@stellar/stellar-sdk";
import { cctp, stellar } from "#cctp/config";

export type Hex = `0x${string}`;

const toHex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString("hex")}`;

function fromHex(value: string): Buffer {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("Invalid hex string");
  return Buffer.from(clean, "hex");
}

export function isValidForwardRecipient(strkey: string): boolean {
  return StrKey.isValidEd25519PublicKey(strkey) || StrKey.isValidContract(strkey) || StrKey.isValidMed25519PublicKey(strkey);
}

/**
 * Hook data read by `CctpForwarder`: 24 zero bytes, version (u32 BE) = 0,
 * recipient length (u32 BE), then the recipient strkey as UTF-8.
 * A wrong recipient here cannot be recovered, so it is validated first.
 */
export function buildForwarderHookData(recipient: string): Hex {
  if (!isValidForwardRecipient(recipient)) throw new Error(`Invalid Stellar recipient: ${recipient}`);
  const recipientBytes = Buffer.from(recipient, "utf8");
  const hookData = Buffer.alloc(32 + recipientBytes.length);
  hookData.writeUInt32BE(0, 24);
  hookData.writeUInt32BE(recipientBytes.length, 28);
  recipientBytes.copy(hookData, 32);
  return toHex(hookData);
}

export function decodeForwarderHookData(hookData: Hex): string {
  const bytes = fromHex(hookData);
  if (bytes.length < 32) throw new Error("Hook data too short");
  if (bytes.subarray(0, 24).some(byte => byte !== 0)) throw new Error("Unexpected hook data magic");
  if (bytes.readUInt32BE(24) !== 0) throw new Error("Unsupported hook data version");
  const length = bytes.readUInt32BE(28);
  if (bytes.length < 32 + length) throw new Error("Hook data recipient truncated");
  return bytes.subarray(32, 32 + length).toString("utf8");
}

export function contractStrkeyToBytes32(strkey: string): Hex {
  if (!StrKey.isValidContract(strkey)) throw new Error(`Invalid contract strkey: ${strkey}`);
  return toHex(StrKey.decodeContract(strkey));
}

/** CCTP messages carry six-decimal USDC; Stellar USDC has seven decimals. */
export function cctpToStellarAmount(amount: bigint): bigint {
  if (amount < 0n) throw new Error("Negative amount");
  return amount * 10n;
}

/** Iris quotes the fee in basis points, possibly fractional; round the budget up. */
export function maxFeeFor(amount: bigint, minimumFeeBps: number): bigint {
  if (!Number.isFinite(minimumFeeBps) || minimumFeeBps < 0) throw new Error(`Invalid fee quote: ${minimumFeeBps}`);
  const centiBps = BigInt(Math.ceil(minimumFeeBps * 100));
  return (amount * centiBps + 999_999n) / 1_000_000n;
}

export interface BurnMessage {
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  destinationCaller: Hex;
  finalityThresholdExecuted: number;
  mintRecipient: Hex;
  amount: bigint;
  maxFee: bigint;
  feeExecuted: bigint;
  hookData: Hex;
}

const HEADER = 148;
const BODY = 228;

/** Parses a CCTP V2 message (MessageV2 header + BurnMessageV2 body) as returned by Iris. */
export function decodeBurnMessage(message: Hex): BurnMessage {
  const bytes = fromHex(message);
  if (bytes.length < HEADER + BODY) throw new Error("CCTP message too short");
  const word = (offset: number) => BigInt(toHex(bytes.subarray(offset, offset + 32)));
  const body = HEADER;
  return {
    sourceDomain: bytes.readUInt32BE(4),
    destinationDomain: bytes.readUInt32BE(8),
    nonce: toHex(bytes.subarray(12, 44)),
    destinationCaller: toHex(bytes.subarray(108, 140)),
    finalityThresholdExecuted: bytes.readUInt32BE(144),
    mintRecipient: toHex(bytes.subarray(body + 36, body + 68)),
    amount: word(body + 68),
    maxFee: word(body + 132),
    feeExecuted: word(body + 164),
    hookData: toHex(bytes.subarray(body + BODY)),
  };
}

/** Refuses a message that would not pay `recipient` through the forwarder. */
export function assertForwarderMessage(message: BurnMessage, recipient: string): void {
  const forwarder = contractStrkeyToBytes32(stellar.cctpForwarder);
  if (message.destinationDomain !== cctp.stellarDomain) throw new Error(`Message is for domain ${message.destinationDomain}`);
  if (message.mintRecipient !== forwarder) throw new Error("Mint recipient is not the CCTP forwarder");
  if (message.destinationCaller !== forwarder) throw new Error("Destination caller is not the CCTP forwarder");
  const forwardTo = decodeForwarderHookData(message.hookData);
  if (forwardTo !== recipient) throw new Error(`Message forwards to ${forwardTo}, expected ${recipient}`);
}

/** Seven-decimal amount the forwarder pays out on Stellar. */
export function mintedOnStellar(message: BurnMessage): bigint {
  return cctpToStellarAmount(message.amount - message.feeExecuted);
}
