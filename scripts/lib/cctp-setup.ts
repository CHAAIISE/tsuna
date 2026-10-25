import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Address, Asset, Keypair, Operation, StrKey, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { stellar } from "../../web/lib/cctp/config.js";
import { pegPlan, poolReserves, restorePeg } from "../../web/lib/cctp/stellar.js";
import {
  RATE, UNIT, address, balance, call, horizon, i128, read, request, send, server, symbol, testnet, vec,
  type Positions, type Reserve,
} from "./stellar.js";

const envFile = fileURLToPath(new URL("../../.env.local", import.meta.url));
const deploymentFile = fileURLToPath(new URL("../../deployments/cctp.testnet.json", import.meta.url));
/** `agent_vault` wasm already uploaded to testnet (instance of the latest spike vault). */
export const VAULT_WASM_HASH = "970dbd1bc6a15952083c654fc81d1e2389c2e99201533bffc2e969d5f97ac189";
const XLM_RESERVE = 50n * UNIT;

export interface CctpDeployment {
  network: "testnet";
  vault: string;
  vaultWasmHash: string;
  vaultDeployTx: string;
  vaultOwner: string;
  soroswapPair: string;
  bridgeUser: string;
}

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const toAmount = (stroops: bigint) => `${stroops / UNIT}.${(stroops % UNIT).toString().padStart(7, "0")}`;

async function xlmBalance(account: string): Promise<bigint> {
  const loaded = await horizon.loadAccount(account);
  const native = loaded.balances.find(line => line.asset_type === "native");
  return native ? BigInt(native.balance.replace(".", "")) : 0n;
}

async function accountExists(account: string): Promise<boolean> {
  try {
    await server.getAccount(account);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) return false;
    throw error;
  }
}

/** Friendbot pays 10,000 XLM per new account: fund throwaway accounts and merge them in. */
export async function topUpXlm(key: Keypair, minimum: bigint): Promise<void> {
  while (await xlmBalance(key.publicKey()) < minimum) {
    const donor = Keypair.random();
    await server.fundAddress(donor.publicKey());
    const merged = await send(donor, Operation.accountMerge({ destination: key.publicKey() }), false);
    console.log(`MERGE_FRIENDBOT_XLM ${merged.txHash}`);
  }
}

export async function ensureDemoUser(): Promise<Keypair> {
  let secret = process.env.LEASH_BRIDGE_USER_SECRET;
  if (!secret) {
    const created = Keypair.random();
    secret = created.secret();
    appendFileSync(envFile, `${readFileSync(envFile, "utf8").endsWith("\n") ? "" : "\n"}LEASH_BRIDGE_USER_SECRET=${secret}\n`);
    process.env.LEASH_BRIDGE_USER_SECRET = secret;
    console.log(`BRIDGE_USER_CREATED ${created.publicKey()}`);
  }
  const user = Keypair.fromSecret(secret);
  if (!await accountExists(user.publicKey())) {
    const funded = await server.fundAddress(user.publicKey());
    console.log(`BRIDGE_USER_FUNDED ${funded.txHash}`);
  }
  return user;
}

async function hasTrustline(account: string, issuer: string): Promise<boolean> {
  const loaded = await horizon.loadAccount(account);
  return loaded.balances.some(line => "asset_issuer" in line && line.asset_issuer === issuer && "asset_code" in line && line.asset_code === "USDC");
}

/** Trustline through the SAC `trust` function (CAP-73). */
async function ensureTrust(key: Keypair, sac: string, issuer: string): Promise<void> {
  if (await hasTrustline(key.publicKey(), issuer)) return;
  const trusted = await send(key, call(sac, "trust", [address(key.publicKey())]));
  console.log(`SAC_TRUST ${sac} ${trusted.txHash}`);
}

/** Borrows Blend USDC against XLM collateral until `key` holds `target` (health factor 1.75). */
export async function ensureBlendUsdc(key: Keypair, target: bigint): Promise<void> {
  const owner = key.publicKey();
  await ensureTrust(key, testnet.usdc, testnet.issuer);
  const held = await balance(key, owner);
  if (held >= target) return;
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
  const debt = ceil((positions.liabilities[usdc.config.index] ?? 0n) * usdc.data.d_rate, RATE) + borrow;
  const required = ceil(debt * usdcPrice * 175n * UNIT * UNIT,
    xlmPrice * 100n * BigInt(xlm.config.c_factor) * BigInt(usdc.config.l_factor));
  const collateral = (positions.collateral[xlm.config.index] ?? 0n) * xlm.data.b_rate / RATE;
  const additional = required > collateral ? required - collateral : 0n;
  if (additional > 0n) {
    await topUpXlm(key, additional + XLM_RESERVE);
    const supplied = await send(key, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.xlm, additional, 2)])]));
    console.log(`BLEND_SUPPLY_XLM ${toAmount(additional)} ${supplied.txHash}`);
  }
  const borrowed = await send(key, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.usdc, borrow, 4)])]));
  console.log(`BLEND_BORROW_USDC ${toAmount(borrow)} ${borrowed.txHash}`);
}

/** Buys Circle testnet USDC with XLM on the Stellar DEX until `key` holds `target`. */
export async function ensureCircleUsdc(key: Keypair, target: bigint): Promise<void> {
  await ensureTrust(key, stellar.circleUsdc, stellar.circleUsdcIssuer);
  const held = await balance(key, key.publicKey(), stellar.circleUsdc);
  if (held >= target) return;
  const asset = new Asset("USDC", stellar.circleUsdcIssuer);
  const destAmount = toAmount(target - held);
  const paths = await horizon.strictReceivePaths([Asset.native()], asset, destAmount).call();
  const best = paths.records.find(record => record.source_asset_type === "native");
  if (!best) throw new Error("No DEX path from XLM to Circle USDC");
  const sendMax = BigInt(best.source_amount.replace(".", "")) * 101n / 100n;
  await topUpXlm(key, sendMax + XLM_RESERVE);
  const bought = await send(key, Operation.pathPaymentStrictReceive({
    sendAsset: Asset.native(),
    sendMax: toAmount(sendMax),
    destination: key.publicKey(),
    destAsset: asset,
    destAmount,
    path: best.path.map(hop => hop.asset_type === "native" ? Asset.native() : new Asset(hop.asset_code, hop.asset_issuer)),
  }), false);
  console.log(`DEX_BUY_CIRCLE_USDC ${destAmount} ${bought.txHash}`);
}

const deadline = () => nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 600), { type: "u64" });

/**
 * Makes the Circle-USDC / Blend-USDC Soroswap pair trade at 1:1 with at least
 * `depth` of each token, so a bridged amount swaps above the 99.5 % floor. Bridged
 * swaps leave Circle USDC cheap, so `key` keeps `pegBuffer` Blend USDC to re-peg the pair.
 */
export async function ensurePool(key: Keypair, depth: bigint, pegBuffer: bigint): Promise<string> {
  const owner = key.publicKey();
  await ensureTrust(key, stellar.circleUsdc, stellar.circleUsdcIssuer);
  await ensureTrust(key, testnet.usdc, testnet.issuer);
  let reserves = await poolReserves(owner);
  const plan = pegPlan(reserves);
  if (plan) {
    if (plan.tokenIn === testnet.usdc) await ensureBlendUsdc(key, plan.amountIn);
    else await ensureCircleUsdc(key, plan.amountIn);
    const { hash } = await restorePeg(key, plan);
    console.log(`POOL_REBALANCE ${toAmount(plan.amountIn)} ${plan.tokenIn === testnet.usdc ? "Blend→Circle" : "Circle→Blend"} ${hash}`);
    reserves = await poolReserves(owner);
  }
  const shallow = reserves.circle < reserves.blend ? reserves.circle : reserves.blend;
  // Small shortfalls (rounding, earlier swaps) do not move a 1 USDC quote below the floor.
  if (shallow < depth * 99n / 100n) {
    const add = depth - shallow;
    await ensureCircleUsdc(key, add);
    await ensureBlendUsdc(key, add);
    const added = await send(key, call(stellar.soroswapRouter, "add_liquidity", [
      address(stellar.circleUsdc), address(stellar.blendUsdc), i128(add), i128(add), i128(add * 99n / 100n), i128(add * 99n / 100n),
      address(owner), deadline(),
    ]));
    console.log(`POOL_ADD_LIQUIDITY ${toAmount(add)} each side ${added.txHash}`);
    reserves = await poolReserves(owner);
  }
  await ensureBlendUsdc(key, pegBuffer);
  console.log(`POOL_RESERVES circle=${toAmount(reserves.circle)} blend=${toAmount(reserves.blend)}`);
  return read<string>(key, stellar.soroswapFactory, "get_pair", [address(stellar.circleUsdc), address(stellar.blendUsdc)]);
}

export function readDeployment(): CctpDeployment | null {
  return existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, "utf8")) as CctpDeployment : null;
}

export function writeDeployment(deployment: CctpDeployment): void {
  mkdirSync(fileURLToPath(new URL("../../deployments/", import.meta.url)), { recursive: true });
  writeFileSync(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`);
}

/** Reuses `LEASH_BRIDGE_VAULT` or the recorded test vault; otherwise deploys one owned by `key`. */
export async function ensureVault(key: Keypair): Promise<{ vault: string; deployTx: string | null }> {
  const override = process.env.LEASH_BRIDGE_VAULT;
  if (override) {
    if (!StrKey.isValidContract(override)) throw new Error("LEASH_BRIDGE_VAULT is not a contract address");
    return { vault: override, deployTx: null };
  }
  const recorded = readDeployment();
  if (recorded) {
    const asset = await read<string[]>(key, recorded.vault, "assets").catch(() => null);
    if (asset?.[0] === testnet.usdc) return { vault: recorded.vault, deployTx: recorded.vaultDeployTx };
  }
  const owner = key.publicKey();
  const deployed = await send(key, Operation.createCustomContract({
    address: new Address(owner),
    wasmHash: Buffer.from(VAULT_WASM_HASH, "hex"),
    salt: randomBytes(32),
    constructorArgs: [address(owner), address(owner), address(testnet.usdc), address(owner)],
  }));
  if (!deployed.returnValue) throw new Error(`Vault deployment ${deployed.txHash} returned no address`);
  const vault = scValToNative(deployed.returnValue) as string;
  console.log(`VAULT_DEPLOYED ${vault} ${deployed.txHash}`);
  return { vault, deployTx: deployed.txHash };
}
