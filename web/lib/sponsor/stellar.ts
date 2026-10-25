import "server-only";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  Address, Contract, Keypair, Networks, StrKey, Transaction, TransactionBuilder, rpc, scValToNative, xdr,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { passkeyDeployment } from "@/lib/passkey/deployment";

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const server = new rpc.Server(process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org");
/** Highest resource fee the relayer accepts to pay for one transaction (5 XLM). */
export const MAX_RESOURCE_FEE = 50_000_000n;
const INCLUSION_FEE = "1000";

/** An error whose message is safe to show to the user. */
export class SponsorError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function serverKey(name: "LEASH_RELAYER_SECRET" | "LEASH_FAUCET_SECRET"): Keypair {
  const secret = process.env[name];
  if (!secret) throw new SponsorError("The testnet relayer is not configured on this server.", 503);
  return Keypair.fromSecret(secret);
}

const queues = new Map<string, Promise<unknown>>();

/** Runs tasks that consume `source`'s sequence number one at a time. */
export function serialize<T>(source: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(source) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(source, next);
  return next;
}

/** Stellar Asset Contract error for a classic account without a trustline. */
export const SAC_TRUSTLINE_MISSING = 13;

/** A failed simulation, with the contract error code when there is one. */
export class SimulationError extends SponsorError {
  readonly contractCode: number | null;

  constructor(diagnostic: string) {
    const code = /Error\(Contract, #(\d+)\)/.exec(diagnostic)?.[1];
    const message = /Error\(Auth|Error\(Crypto/.test(diagnostic)
      ? "The signature was refused by the account contract."
      : code ? `The contract refused the call (error #${code}).` : "The transaction failed in simulation.";
    super(message, 422);
    this.contractCode = code ? Number(code) : null;
  }
}

export async function simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) throw new SimulationError(simulation.error);
  if (rpc.Api.isSimulationRestore(simulation)) throw new SponsorError("A ledger entry has expired and must be restored first.", 409);
  if (BigInt(simulation.minResourceFee) > MAX_RESOURCE_FEE) throw new SponsorError("This call is too expensive to sponsor.", 422);
  return simulation;
}

export async function buildTransaction(source: string, operation: xdr.Operation): Promise<Transaction> {
  return new TransactionBuilder(await server.getAccount(source), { fee: INCLUSION_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(operation)
    .setTimeout(120)
    .build();
}

export interface Submitted {
  hash: string;
  returnValue?: xdr.ScVal;
}

export async function sendAndWait(tx: Transaction | FeeBumpTransaction): Promise<Submitted> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    throw new SponsorError(`Stellar did not accept the transaction (${sent.status}).`, 502);
  }
  const result = await server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1000 });
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return result.returnValue ? { hash: sent.hash, returnValue: result.returnValue } : { hash: sent.hash };
  }
  if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new SponsorError(`The transaction failed on-chain (${sent.hash}).`, 422);
  }
  throw new SponsorError(`The transaction is still pending (${sent.hash}).`, 504);
}

/** Simulates, assembles, signs with `source` and submits a Soroban operation. */
export function submitOperation(
  source: Keypair,
  operation: xdr.Operation,
  inspect?: (simulation: rpc.Api.SimulateTransactionSuccessResponse) => void,
): Promise<Submitted> {
  return serialize(source.publicKey(), async () => {
    const tx = await buildTransaction(source.publicKey(), operation);
    const simulation = await simulate(tx);
    inspect?.(simulation);
    const prepared = rpc.assembleTransaction(tx, simulation).build();
    prepared.sign(source);
    return sendAndWait(prepared);
  });
}

export async function readContract<T>(contract: string, method: string, args: xdr.ScVal[]): Promise<T> {
  const tx = await buildTransaction(passkeyDeployment.relayer, new Contract(contract).call(method, ...args));
  const simulation = await simulate(tx);
  if (!simulation.result) throw new SponsorError(`No value returned by ${method}.`, 502);
  return scValToNative(simulation.result.retval) as T;
}

export function usdcBalance(owner: string): Promise<bigint> {
  return readContract<bigint>(passkeyDeployment.usdc, "balance", [new Address(owner).toScVal()]);
}

/** Wasm hash of a deployed contract, or `null` when it does not exist. */
export async function contractWasmHash(contract: string): Promise<string | null> {
  try {
    const entry = await server.getContractData(contract, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
    const data = entry.val;
    if (data.type !== "contractData" || data.contractData.val.type !== "scvContractInstance") return null;
    const executable = data.contractData.val.instance.executable;
    return executable.type === "contractExecutableWasm"
      ? executable.wasmHash.toString()
      : null;
  } catch (error) {
    // The RPC client rejects with a plain `{ code: 404 }` object for missing entries.
    if (typeof error === "object" && error !== null && "code" in error && error.code === 404) return null;
    throw error;
  }
}

let allowlist: Set<string> | undefined;

/**
 * Contracts a passkey account may call through the relayer: Blend USDC plus
 * every contract recorded in `deployments/*.json` (vaults, factory…).
 */
export function sponsoredContracts(): Set<string> {
  if (allowlist) return allowlist;
  const contracts = new Set<string>([passkeyDeployment.usdc]);
  const dir = path.join(process.cwd(), "..", "deployments");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(file => file.endsWith(".json"));
  } catch {
    // Deployment records are optional; USDC stays callable without them.
  }
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), "utf8");
    for (const match of text.matchAll(/"(C[A-Z2-7]{55})"/g)) {
      if (match[1] && StrKey.isValidContract(match[1])) contracts.add(match[1]);
    }
  }
  contracts.delete(passkeyDeployment.verifier);
  allowlist = contracts;
  return contracts;
}
