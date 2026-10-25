import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  Address, Contract, Horizon, Keypair, Networks, SorobanDataBuilder, Transaction, TransactionBuilder,
  nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import type { FeeBumpTransaction } from "@stellar/stellar-sdk";

loadEnvFile(fileURLToPath(new URL("../../.env.local", import.meta.url)));

export const server = new rpc.Server("https://soroban-testnet.stellar.org");
export const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
export const testnet = {
  pool: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
  xlm: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  usdc: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
  issuer: "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
} as const;
export const UNIT = 10_000_000n;
export const RATE = 1_000_000_000_000n;

export function signer(name: string): Keypair {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return Keypair.fromSecret(value);
}

export const address = (value: string) => new Address(value).toScVal();
export const symbol = (value: string) => nativeToScVal(value, { type: "symbol" });
export const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
export const u32 = (value: number) => nativeToScVal(value, { type: "u32" });
export const vec = (values: xdr.ScVal[]) => xdr.ScVal.scvVec(values);
export const call = (id: string, fn: string, args: xdr.ScVal[] = []) => new Contract(id).call(fn, ...args);

export function request(asset: string, amount: bigint, type: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("address"), val: address(asset) }),
    new xdr.ScMapEntry({ key: symbol("amount"), val: i128(amount) }),
    new xdr.ScMapEntry({ key: symbol("request_type"), val: u32(type) }),
  ]);
}

/** `CallRule` struct: fields are encoded as a map sorted by key. */
export function callRule(args: string[], maxLossBps: number, approve: boolean): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("approve"), val: xdr.ScVal.scvBool(approve) }),
    new xdr.ScMapEntry({ key: symbol("args"), val: vec(args.map(rule => vec([symbol(rule)]))) }),
    new xdr.ScMapEntry({ key: symbol("max_loss_bps"), val: u32(maxLossBps) }),
  ]);
}

export async function build(key: Keypair, operation: xdr.Operation): Promise<Transaction> {
  return new TransactionBuilder(await server.getAccount(key.publicKey()), {
    fee: "10000", networkPassphrase: Networks.TESTNET,
  }).addOperation(operation).setTimeout(120).build();
}

export async function simulate(key: Keypair, operation: xdr.Operation) {
  const tx = await build(key, operation);
  const simulation = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(rpc.Api.isSimulationError(simulation) ? simulation.error : "Simulation requires restoration");
  }
  if (rpc.Api.isSimulationRestore(simulation)) throw new Error("Ledger entries need restoration");
  return { tx, simulation };
}

export async function read<T>(key: Keypair, id: string, fn: string, args: xdr.ScVal[] = []): Promise<T> {
  const { simulation } = await simulate(key, call(id, fn, args));
  if (!simulation.result) throw new Error(`Missing return value for ${fn}`);
  return scValToNative(simulation.result.retval) as T;
}

export async function submit(key: Keypair, tx: Transaction | FeeBumpTransaction) {
  tx.sign(key);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    const diagnostics = (sent.diagnosticEvents ?? []).map(event => scValToNative(event.event.body.v0.data));
    throw new Error(`Submission ${sent.status}: ${sent.errorResult?.toXdr("base64") ?? sent.hash}; ${JSON.stringify(diagnostics, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value)}`);
  }
  const result = await server.pollTransaction(sent.hash, { attempts: 60, sleepStrategy: () => 1000 });
  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) throw new Error(`Transaction not found: ${sent.hash}`);
  return result;
}

export async function send(key: Keypair, operation: xdr.Operation, soroban = true, feePayer = key) {
  const input = soroban ? await simulate(key, operation) : { tx: await build(key, operation) };
  let prepared: Transaction | FeeBumpTransaction = input.tx;
  if ("simulation" in input) {
    const { tx: raw, simulation } = input;
    const data = simulation.transactionData.build();
    if (data.resourceFee + 10_000n > 0xffff_ffffn || feePayer.publicKey() !== key.publicKey()) {
      const capped = new SorobanDataBuilder(data).setResourceFee(0).build();
      const tx = rpc.assembleTransaction(raw, simulation).setSorobanData(capped).build();
      const envelope = tx.toEnvelope();
      if (envelope.type !== "envelopeTypeTx") throw new Error("Expected a v1 transaction");
      // Protocol 23+ allows an underfunded inner fee when the outer fee bump pays it.
      const inner = new Transaction(xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
        tx: new xdr.Transaction({ ...envelope.value.tx, ext: xdr.TransactionExt.sorobanData(data) }),
        signatures: [],
      })), Networks.TESTNET);
      inner.sign(key);
      prepared = TransactionBuilder.buildFeeBumpTransaction(feePayer, "10000", inner, Networks.TESTNET);
    } else {
      prepared = rpc.assembleTransaction(raw, simulation).build();
    }
  }
  const result = await submit(feePayer, prepared);
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Transaction FAILED: ${result.txHash}`);
  return result;
}

export async function balance(key: Keypair, owner: string, asset: string = testnet.usdc): Promise<bigint> {
  return read<bigint>(key, asset, "balance", [address(owner)]);
}

export interface Reserve {
  config: { index: number; c_factor: number; l_factor: number; decimals: number };
  data: { b_rate: bigint; d_rate: bigint };
}
export interface Positions {
  collateral: Record<string, bigint>;
  liabilities: Record<string, bigint>;
  supply: Record<string, bigint>;
}

export function fail(error: unknown): void {
  // Avoid logging SDK errors wholesale: request bodies can contain signed envelopes.
  console.error(error instanceof Error ? error.message : "Testnet operation failed");
  process.exitCode = 1;
}
