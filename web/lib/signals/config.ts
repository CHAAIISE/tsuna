import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import deployment from "../../../deployments/pay.testnet.json";

export const NETWORK = "stellar:testnet" as const;
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const USDC = deployment.usdc;
/** Signal revenue goes to the Tsuna operations account, which holds a USDC trustline. */
export const PAY_TO = deployment.payTo;
export const USDC_DECIMALS = 7;

export const rpcServer = new rpc.Server(process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org");

/** Price of one signal call in USDC, as a decimal string (default 2 USDC). */
export function signalPrice(): string {
  const price = process.env.SIGNAL_PRICE_USDC ?? "2";
  if (!/^\d+(\.\d{1,7})?$/.test(price) || Number(price) <= 0) throw new Error("SIGNAL_PRICE_USDC must be a positive USDC amount");
  return price;
}

export function toStroops(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
}

/** Account that submits settlements and pays their network fees. */
export function facilitatorKey(): Keypair {
  const secret = process.env.LEASH_FACILITATOR_SECRET;
  if (!secret) throw new Error("Missing LEASH_FACILITATOR_SECRET");
  return Keypair.fromSecret(secret);
}
