import { setTimeout as sleep } from "node:timers/promises";
import { cctp } from "#cctp/config";
import type { Hex } from "#cctp/encoding";

export interface IrisMessage {
  status: string;
  message: Hex;
  attestation: Hex;
  delayReason?: string | null;
}

/** Iris minimum fee, in basis points, for the given finality threshold. */
export async function fetchMinimumFeeBps(sourceDomain: number, destinationDomain: number, finalityThreshold: number): Promise<number> {
  const response = await fetch(`${cctp.irisApi}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`);
  if (!response.ok) throw new Error(`Iris fees ${response.status}`);
  const tiers = (await response.json()) as { finalityThreshold: number; minimumFee: number }[];
  const tier = tiers.find(entry => entry.finalityThreshold === finalityThreshold);
  if (!tier) throw new Error(`Iris returned no fee for finality ${finalityThreshold}`);
  return tier.minimumFee;
}

export async function fetchAttestation(sourceDomain: number, transactionHash: string): Promise<IrisMessage | null> {
  // Hex hashes are case-insensitive for Iris only once lowercased.
  const hash = /^(0x)?[0-9a-fA-F]+$/.test(transactionHash) ? transactionHash.toLowerCase() : transactionHash;
  const response = await fetch(`${cctp.irisApi}/v2/messages/${sourceDomain}?transactionHash=${hash}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Iris ${response.status}`);
  const body = (await response.json()) as { messages?: IrisMessage[] };
  return body.messages?.[0] ?? null;
}

export async function pollAttestation(
  sourceDomain: number,
  transactionHash: string,
  onStatus: (status: string) => void,
  { intervalMs = 5_000, timeoutMs = 30 * 60_000 } = {},
): Promise<IrisMessage> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    let status: string;
    try {
      const message = await fetchAttestation(sourceDomain, transactionHash);
      if (message?.status === "complete" && message.attestation.startsWith("0x") && message.attestation.length > 2) return message;
      status = message ? message.delayReason ? `${message.status} (${message.delayReason})` : message.status : "not indexed yet";
    } catch (error) {
      status = `retrying: ${error instanceof Error ? error.message : "Iris unavailable"}`;
    }
    if (status !== lastStatus) onStatus(status);
    lastStatus = status;
    await sleep(intervalMs);
  }
  throw new Error(`No attestation after ${Math.round(timeoutMs / 60_000)} minutes`);
}
