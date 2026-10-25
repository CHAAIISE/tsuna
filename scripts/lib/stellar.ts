import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  Address, Contract, Horizon, Keypair, Networks, Operation, SorobanDataBuilder, Transaction, TransactionBuilder,
  authorizeEntry, nativeToScVal, rpc, scValToNative, xdr,
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

/**
 * Drawdown breaker of the Leverage vault, sized to its XLM book (a small share of NAV): a 30 %
 * XLM crash breaches it, ordinary daily XLM moves do not. The 20 % default could never trip.
 */
export const LEVERAGE_MAX_DRAWDOWN_BPS = 25;

/** One allowlisted `(target, fn)` pair and its `CallRule`. */
export interface Permission {
  target: string;
  fn: string;
  rule: xdr.ScVal;
}

const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: symbol(key), val });
/** Ordinal string order, as the host sorts symbols (unlike `localeCompare`). */
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Host order of addresses (their `ScAddress` XDR), which strkey string order does not follow. */
export const byAddress = (a: string, b: string) =>
  Buffer.compare(new Address(a).toScAddress().toXDR(), new Address(b).toScAddress().toXDR());

/** `Quota` of a named role: its own per-call, daily, rate and loss budgets. */
export interface Quota {
  tx_cap_bps: number;
  daily_cap_bps: number;
  calls_per_hour: number;
  daily_loss_bps: number;
}

/** Named agent role: a member key with its own allowlist and quota, `RiskOff` calls checked on outcome. */
export interface RoleSpec {
  member: string;
  mode: "Normal" | "RiskOff";
  calls: Permission[];
  quota: Quota;
}

/** Optional `PolicyV2` fields: custody contracts and exposure caps (bps) per protocol, named roles. */
export interface PolicyExtras {
  guards?: Record<string, string[]>;
  exposureCaps?: Record<string, number>;
  roles?: Record<string, RoleSpec>;
}

/** Struct of numeric fields, encoded as a map sorted by field name. */
const numbers = (values: object) => xdr.ScVal.scvMap(Object.entries(values)
  .sort(([a], [b]) => byKey(a, b))
  .map(([key, value]) => field(key, u32(value as number))));

/** `Map<(Address, Symbol), CallRule>`, sorted by target address then function. */
const callMap = (calls: Permission[]) => xdr.ScVal.scvMap([...calls]
  .sort((a, b) => byAddress(a.target, b.target) || byKey(a.fn, b.fn))
  .map(({ target, fn, rule }) => new xdr.ScMapEntry({ key: vec([address(target), symbol(fn)]), val: rule })));

/** `Role` struct of the policy registry, as `propose_role` and `PolicyV2.roles` take it. */
export function role({ member, mode, calls, quota }: RoleSpec): xdr.ScVal {
  return xdr.ScVal.scvMap([
    field("calls", callMap(calls)),
    field("member", address(member)),
    field("mode", vec([symbol(mode)])),
    field("quota", numbers(quota)),
  ]);
}

/**
 * `PolicyV2` struct of the policy registry.
 * Soroban maps must be sorted: struct fields by name, calls by target address then function.
 */
export function policy(
  assets: string[], calls: Permission[], protocols: string[], limits: Limits, extras: PolicyExtras = {},
): xdr.ScVal {
  const byEntry = ([a]: [string, unknown], [b]: [string, unknown]) => byAddress(a, b);
  const caps = extras.exposureCaps && Object.entries(extras.exposureCaps).sort(byEntry);
  const roles = extras.roles && Object.entries(extras.roles).sort(([a], [b]) => byKey(a, b));
  return xdr.ScVal.scvMap([
    field("assets", vec(assets.map(address))),
    field("calls", callMap(calls)),
    field("exposure_caps", caps
      ? xdr.ScVal.scvMap(caps.map(([protocol, bps]) => new xdr.ScMapEntry({ key: address(protocol), val: u32(bps) })))
      : xdr.ScVal.scvVoid()),
    field("guards", xdr.ScVal.scvMap(Object.entries(extras.guards ?? {}).sort(byEntry).map(([protocol, custody]) =>
      new xdr.ScMapEntry({ key: address(protocol), val: vec(custody.map(address)) })))),
    field("limits", numbers(limits)),
    field("protocols", vec(protocols.map(address))),
    field("roles", roles
      ? xdr.ScVal.scvMap(roles.map(([name, spec]) => new xdr.ScMapEntry({ key: symbol(name), val: role(spec) })))
      : xdr.ScVal.scvVoid()),
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
 * Sends `operation` from `key` after `cosigners` sign the authorization entries naming them
 * (e.g. the second admin of a 2-of-2 contract). The signed entries are simulated again so the
 * resource estimate covers their signature checks.
 */
export async function sendCosigned(key: Keypair, operation: xdr.Operation, cosigners: Keypair[]) {
  if (operation.body.type !== "invokeHostFunction") throw new Error("Expected a contract invocation");
  const { simulation } = await simulate(key, operation);
  const validUntil = (await server.getLatestLedger()).sequence + 100;
  const auth = await Promise.all((simulation.result?.auth ?? []).map(async entry => {
    if (entry.credentials.type === "sorobanCredentialsSourceAccount") return entry;
    for (const cosigner of cosigners) {
      // `forAddress` makes the SDK refuse an entry that does not name this cosigner.
      const signed = await authorizeEntry(entry, cosigner, validUntil, Networks.TESTNET, cosigner.publicKey()).catch(() => null);
      if (signed) return signed;
    }
    throw new Error("An authorization entry names no provided cosigner");
  }));
  return send(key, Operation.invokeHostFunction({ func: operation.body.value.hostFunction, auth }));
}

/** Release build of `contract` from `stellar contract build`. */
export const releaseWasm = (contract: string) =>
  fileURLToPath(new URL(`../../contracts/target/wasm32v1-none/release/${contract}.wasm`, import.meta.url));

/**
 * Deploys the WASM at `wasmFile` (by default the release build of `contract`) with
 * `constructorArgs`, uploading it only when the network does not already hold that exact code.
 */
export async function deployContract(
  admin: Keypair, contract: string, constructorArgs: xdr.ScVal[], wasmFile = releaseWasm(contract),
) {
  const wasm = await readFile(wasmFile);
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
  return { id: scValToNative(deployed.returnValue) as string, txHash: deployed.txHash, wasmHash: wasmHash.toString("hex") };
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
