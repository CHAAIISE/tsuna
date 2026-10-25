import "server-only";
import { Address, Contract, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { USDC_DECIMALS, passkeyDeployment } from "@/lib/passkey/deployment";
import { SAC_TRUSTLINE_MISSING, SimulationError, SponsorError, serverKey, submitOperation, usdcBalance } from "./stellar";

/** Amount sent per request, in whole USDC (`LEASH_FAUCET_AMOUNT_USDC`, default 1,000). */
export function faucetAmount(): bigint {
  const configured = process.env.LEASH_FAUCET_AMOUNT_USDC ?? "1000";
  if (!/^[1-9]\d{0,6}$/.test(configured)) throw new SponsorError("The faucet amount is misconfigured.", 503);
  return BigInt(configured) * 10n ** BigInt(USDC_DECIMALS);
}

export function assertRecipient(address: string): void {
  if (!StrKey.isValidContract(address) && !StrKey.isValidEd25519PublicKey(address)) {
    throw new SponsorError("Enter a Stellar address (G… or C…).");
  }
  if (address === passkeyDeployment.faucet) throw new SponsorError("The faucet cannot pay itself.");
}

/** Sends test USDC from the faucet stock to `recipient`. */
export async function dripUsdc(recipient: string): Promise<{ hash: string; amount: bigint }> {
  assertRecipient(recipient);
  const faucet = serverKey("LEASH_FAUCET_SECRET");
  const amount = faucetAmount();
  if (await usdcBalance(faucet.publicKey()) < amount) throw new SponsorError("The faucet is empty. Try again later.", 503);
  const transfer = new Contract(passkeyDeployment.usdc).call(
    "transfer",
    new Address(faucet.publicKey()).toScVal(),
    new Address(recipient).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
  );
  try {
    const { hash } = await submitOperation(faucet, transfer);
    return { hash, amount };
  } catch (error) {
    if (error instanceof SimulationError && error.contractCode === SAC_TRUSTLINE_MISSING) {
      throw new SponsorError("This account has no USDC trustline yet. Add it, then try again.", 409);
    }
    throw error;
  }
}
