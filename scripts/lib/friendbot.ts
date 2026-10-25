import { Keypair, Operation } from "@stellar/stellar-sdk";
import { UNIT, balance, send, server, testnet } from "./stellar.js";

/** Creates `key`'s account with Friendbot when it does not exist yet. */
export async function ensureAccount(key: Keypair): Promise<void> {
  try {
    await server.getAccount(key.publicKey());
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("not found")) throw error;
    const funded = await server.fundAddress(key.publicKey());
    console.log(`FRIENDBOT ${funded.txHash}`);
  }
}

/**
 * Raises `key`'s XLM balance to at least `target` stroops. Friendbot only funds
 * new accounts, so each round funds a throwaway account and merges it into
 * `key` (about 10,000 XLM per round).
 */
export async function topUpXlm(key: Keypair, target: bigint): Promise<bigint> {
  await ensureAccount(key);
  let held = await balance(key, key.publicKey(), testnet.xlm);
  while (held < target) {
    const donor = Keypair.random();
    await server.fundAddress(donor.publicKey());
    const merged = await send(donor, Operation.accountMerge({ destination: key.publicKey() }), false);
    held = await balance(key, key.publicKey(), testnet.xlm);
    console.log(`MERGE_XLM ${merged.txHash} balance=${held / UNIT} XLM`);
  }
  return held;
}
