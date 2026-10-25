import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Address, Asset, Keypair, Operation, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  UNIT, RATE, address, balance, build, call, horizon, i128, read, request, send, server, simulate,
  submit, symbol, testnet, vec, type Positions, type Reserve,
} from "./stellar.js";

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** XLM kept aside for reserves and fees whenever a helper spends the native balance. */
const XLM_RESERVE = 200n * UNIT;

export async function ensureAccount(key: Keypair): Promise<void> {
  try {
    await server.getAccount(key.publicKey());
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("not found")) throw error;
    const funded = await server.fundAddress(key.publicKey());
    console.log(`FRIENDBOT ${key.publicKey()} ${funded.txHash}`);
  }
}

/**
 * Friendbot only funds new accounts, so larger testnet budgets come from
 * throwaway accounts merged into `key`.
 */
export async function topUpXlm(key: Keypair, minimum: bigint): Promise<bigint> {
  let held = await balance(key, key.publicKey(), testnet.xlm);
  while (held < minimum) {
    const donor = Keypair.random();
    await server.fundAddress(donor.publicKey());
    const merged = await submit(donor, await build(donor, Operation.accountMerge({ destination: key.publicKey() })));
    if (merged.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Account merge FAILED: ${merged.txHash}`);
    held = await balance(key, key.publicKey(), testnet.xlm);
    console.log(`MERGED_FRIENDBOT ${merged.txHash} balance=${held}`);
  }
  return held;
}

/** Uploads a WASM unless the network already stores code with the same hash. */
export async function ensureWasm(key: Keypair, path: string): Promise<Buffer> {
  const wasm = await readFile(path);
  const hash = createHash("sha256").update(wasm).digest();
  const stored = await server.getLedgerEntries(xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash })));
  if (stored.entries.length > 0) return hash;
  const upload = Operation.uploadContractWasm({ wasm });
  const { simulation } = await simulate(key, upload);
  await topUpXlm(key, BigInt(simulation.minResourceFee) + XLM_RESERVE);
  const uploaded = await send(key, upload);
  console.log(`WASM_UPLOADED ${path} ${hash.toString("hex")} ${uploaded.txHash}`);
  return hash;
}

export async function contractExists(id: string): Promise<boolean> {
  try {
    await server.getContractData(id, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
    return true;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return false;
    throw error;
  }
}

export async function deployContract(key: Keypair, wasmHash: Buffer, constructorArgs: xdr.ScVal[] = []): Promise<string> {
  const deployed = await send(key, Operation.createCustomContract({
    address: new Address(key.publicKey()), wasmHash, constructorArgs,
  }));
  if (!deployed.returnValue) throw new Error("Deployment must return a contract address");
  const id = scValToNative(deployed.returnValue) as string;
  console.log(`DEPLOYED ${id} ${deployed.txHash}`);
  return id;
}

/**
 * Brings `key` to at least `target` Blend testnet USDC by borrowing against XLM
 * collateral on the Blend pool, targeting a 1.75 health factor.
 */
export async function ensureBlendUsdc(key: Keypair, target: bigint): Promise<bigint> {
  const owner = key.publicKey();
  await ensureAccount(key);
  const account = await horizon.loadAccount(owner);
  if (!account.balances.some(b => b.asset_type !== "native" && "asset_issuer" in b && b.asset_issuer === testnet.issuer && b.asset_code === "USDC")) {
    const trust = await send(key, Operation.changeTrust({ asset: new Asset("USDC", testnet.issuer) }), false);
    console.log(`TRUST_USDC ${trust.txHash}`);
  }
  const held = await balance(key, owner);
  if (held >= target) return held;
  const borrow = target - held;
  const [xlm, usdc, positions, config] = await Promise.all([
    read<Reserve>(key, testnet.pool, "get_reserve", [address(testnet.xlm)]),
    read<Reserve>(key, testnet.pool, "get_reserve", [address(testnet.usdc)]),
    read<Positions>(key, testnet.pool, "get_positions", [address(owner)]),
    read<{ oracle: string }>(key, testnet.pool, "get_config"),
  ]);
  const price = async (asset: string) => {
    const value = await read<{ price: bigint } | null>(key, config.oracle, "lastprice", [vec([symbol("Stellar"), address(asset)])]);
    if (!value || value.price <= 0n) throw new Error(`Missing Blend oracle price for ${asset}`);
    return value.price;
  };
  const [xlmPrice, usdcPrice] = await Promise.all([price(testnet.xlm), price(testnet.usdc)]);
  if (xlm.config.decimals !== 7 || usdc.config.decimals !== 7) throw new Error("Expected seven-decimal reserves");
  const debt = ceil((positions.liabilities[usdc.config.index] ?? 0n) * usdc.data.d_rate, RATE) + borrow;
  const required = ceil(debt * usdcPrice * 175n * UNIT * UNIT,
    xlmPrice * 100n * BigInt(xlm.config.c_factor) * BigInt(usdc.config.l_factor));
  const collateral = (positions.collateral[xlm.config.index] ?? 0n) * xlm.data.b_rate / RATE;
  const additional = required > collateral ? required - collateral : 0n;
  if (additional > 0n) {
    await topUpXlm(key, additional + XLM_RESERVE);
    const supplied = await send(key, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.xlm, additional, 2)])]));
    console.log(`SUPPLY_COLLATERAL ${supplied.txHash}`);
  }
  const borrowed = await send(key, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.usdc, borrow, 4)])]));
  console.log(`BORROW_USDC ${borrowed.txHash}`);
  const stock = await balance(key, owner);
  if (stock < target) throw new Error(`USDC stock below target: ${stock}`);
  return stock;
}

export function transferUsdc(key: Keypair, to: string, amount: bigint) {
  return send(key, call(testnet.usdc, "transfer", [address(key.publicKey()), address(to), i128(amount)]));
}
