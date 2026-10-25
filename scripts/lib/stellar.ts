import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  Address, Contract, Horizon, Keypair, Networks, Operation, SorobanDataBuilder, Transaction, TransactionBuilder,
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

/** Address recorded in `deployments/testnet.json` under `name`. */
export async function deployment(name: string): Promise<string> {
  const file = JSON.parse(
    await readFile(new URL("../../deployments/testnet.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const value = file[name];
  if (typeof value !== "string") throw new Error(`Missing ${name} in deployments/testnet.json`);
  return value;
}

export function signer(name: string): Keypair {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return Keypair.fromSecret(value);
}

export const address = (value: string) => new Address(value).toScVal();
export const symbol = (value: string) => nativeToScVal(value, { type: "symbol" });
export const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
export const u32 = (value: number) => nativeToScVal(value, { type: "u32" });
export const u64 = (value: bigint) => nativeToScVal(value, { type: "u64" });
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

/** Contract defaults of the policy `Limits`, keyed by field name. */
export const defaultLimits = {
  tx_cap_bps: 10_000,
  daily_cap_bps: 100_000,
  calls_per_hour: 60,
  min_health_factor_bps: 13_000,
  max_drawdown_bps: 2_000,
  daily_loss_bps: 50,
  max_exposure_bps: 5_000,
};
export type Limits = typeof defaultLimits;

/** One allowlisted `(target, fn)` pair and its `CallRule`. */
export interface Permission {
  target: string;
  fn: string;
  rule: xdr.ScVal;
}

const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: symbol(key), val });
/** Ordinal string order, as the host sorts symbols (unlike `localeCompare`). */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `PolicyV2` struct of the policy registry, without guards or per-protocol exposure caps.
 * Soroban maps must be sorted: struct fields by name, calls by target address then function.
 */
export function policy(assets: string[], calls: Permission[], protocols: string[], limits: Limits): xdr.ScVal {
  const sorted = [...calls].sort((a, b) =>
    Buffer.compare(new Address(a.target).toScAddress().toXDR(), new Address(b.target).toScAddress().toXDR())
    || byKey(a.fn, b.fn));
  return xdr.ScVal.scvMap([
    field("assets", vec(assets.map(address))),
    field("calls", xdr.ScVal.scvMap(sorted.map(({ target, fn, rule }) =>
      new xdr.ScMapEntry({ key: vec([address(target), symbol(fn)]), val: rule })))),
    field("exposure_caps", xdr.ScVal.scvVoid()),
    field("guards", xdr.ScVal.scvMap([])),
    field("limits", xdr.ScVal.scvMap(Object.entries(limits)
      .sort(([a], [b]) => byKey(a, b))
      .map(([key, value]) => field(key, u32(value))))),
    field("protocols", vec(protocols.map(address))),
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

/**
 * Deploys the release build of `contract` with `constructorArgs`, uploading its WASM only when
 * the network does not already hold that exact code.
 */
export async function deployContract(admin: Keypair, contract: string, constructorArgs: xdr.ScVal[]) {
  const wasm = await readFile(new URL(`../../contracts/target/wasm32v1-none/release/${contract}.wasm`, import.meta.url));
  const wasmHash = createHash("sha256").update(wasm).digest();
  try {
    await server.getContractWasmByHash(wasmHash);
    console.log(`WASM_PRESENT ${contract} ${wasmHash.toString("hex")}`);
  } catch {
    const uploaded = await send(admin, Operation.uploadContractWasm({ wasm }));
    console.log(`WASM_UPLOADED ${contract} ${uploaded.txHash}`);
  }
  const deployed = await send(admin, Operation.createCustomContract({
    address: new Address(admin.publicKey()), wasmHash, constructorArgs,
  }));
  if (!deployed.returnValue) throw new Error(`Deployment of ${contract} returned no address`);
  return { id: scValToNative(deployed.returnValue) as string, txHash: deployed.txHash };
}

/** `AdapterKind` unit variant of the vault: `Blend`, `DeFindex`, `Aquarius`, `Soroswap` or `Xoxno`. */
export const adapterKind = (kind: "Blend" | "DeFindex" | "Aquarius" | "Soroswap" | "Xoxno") => vec([symbol(kind)]);

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
