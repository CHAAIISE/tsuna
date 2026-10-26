import "server-only";
import { Contract, nativeToScVal, xdr, type Keypair } from "@stellar/stellar-sdk";
import type { TxResult } from "@tsuna/sdk";
import { fleetConfig, fleetRecord, tsuna, serverKey, type FleetId } from "./config";
import { isVaultBuild, uploadedWasm } from "./read";

/** An error whose message is safe to show, with the HTTP status to answer. */
export class FleetError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

const FEE_SECRET = "LEASH_FLEET_FEE_SECRET";

let queue: Promise<unknown> = Promise.resolve();

/** Transactions share one fee payer: submit them one at a time so sequence numbers never collide. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(task);
  queue = next;
  return next;
}

/**
 * Fee payer plus the factory's two admins, checked against the admins stored on-chain. The
 * admins only sign authorization entries; the fee payer is the transaction source.
 */
async function signers(fleet: FleetId): Promise<{ factory: string; fee: Keypair; admins: [Keypair, Keypair] }> {
  const config = fleetConfig(fleet);
  if (!config) throw new FleetError("This fleet is not deployed.", 404);
  const fee = serverKey(FEE_SECRET);
  const [a, b] = config.adminSecrets.map(serverKey);
  if (!fee || !a || !b) throw new FleetError("Fleet administration is not configured on this server.", 503);
  const onChain = await tsuna().read<[string, string]>(config.factory, "admins");
  if (onChain[0] !== a.publicKey() || onChain[1] !== b.publicKey()) {
    throw new FleetError("The configured keys are not this factory's admins.", 503);
  }
  return { factory: config.factory, fee, admins: [a, b] };
}

async function invoke(fleet: FleetId, fn: string, args: xdr.ScVal[]): Promise<TxResult> {
  const { factory, fee, admins } = await signers(fleet);
  const client = tsuna();
  return serialized(async () => {
    try {
      const result = await client.chain.invoke(fee, new Contract(factory).call(fn, ...args), admins, "factory");
      if (result.status !== "SUCCESS") {
        throw new FleetError(result.error?.message ?? `The transaction failed on-chain (${result.hash}).`, 422, result.error?.name);
      }
      return result;
    } catch (error) {
      if (error instanceof FleetError) throw error;
      const refusal = client.decodeError(error);
      if (refusal) throw new FleetError(refusal.message, 409, refusal.name);
      throw error;
    }
  });
}

const TAG = nativeToScVal(fleetRecord.tag, { type: "string" });

/** Starts the factory timelock for moving every vault of `fleet` to the uploaded build `wasmHash`. */
export async function proposePatch(fleet: FleetId, wasmHash: string): Promise<TxResult> {
  const wasm = await uploadedWasm(wasmHash);
  if (!wasm) throw new FleetError("No Wasm with this hash is uploaded on testnet.", 422);
  if (!isVaultBuild(wasm)) throw new FleetError("This Wasm does not export the vault interface.", 422);
  return invoke(fleet, "propose_ref", [TAG, xdr.ScVal.scvBytes(Buffer.from(wasmHash, "hex"))]);
}

/** Swaps the factory's executable reference: one transaction moves every vault. */
export function applyPatch(fleet: FleetId): Promise<TxResult> {
  return invoke(fleet, "apply_ref", [TAG]);
}
