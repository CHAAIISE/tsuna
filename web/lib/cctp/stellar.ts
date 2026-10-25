import {
  Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { MIN_SWAP_OUT_BPS, stellar } from "#cctp/config";
import type { Hex } from "#cctp/encoding";

export const sorobanServer = new rpc.Server(stellar.rpcUrl);

const address = (value: string) => new Address(value).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const bytes = (hex: Hex) => nativeToScVal(Buffer.from(hex.slice(2), "hex"), { type: "bytes" });

export interface Invocation {
  hash: string;
  returnValue: unknown;
}

async function simulate(source: string, operation: xdr.Operation) {
  const tx = new TransactionBuilder(await sorobanServer.getAccount(source), {
    fee: "10000", networkPassphrase: stellar.networkPassphrase,
  }).addOperation(operation).setTimeout(120).build();
  const simulation = await sorobanServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error);
  if (rpc.Api.isSimulationRestore(simulation)) throw new Error("Ledger entries need restoration");
  return { tx, simulation };
}

/** Simulates, signs and submits a single Soroban invocation; resolves once it is in a ledger. */
export async function invoke(key: Keypair, operation: xdr.Operation): Promise<Invocation> {
  const { tx, simulation } = await simulate(key.publicKey(), operation);
  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(key);
  const sent = await sorobanServer.sendTransaction(prepared);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") throw new Error(`Stellar rejected ${sent.hash}: ${sent.status}`);
  const result = await sorobanServer.pollTransaction(sent.hash, { attempts: 60, sleepStrategy: () => 1_000 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Stellar transaction ${sent.hash} ended ${result.status}`);
  return { hash: sent.hash, returnValue: result.returnValue ? scValToNative(result.returnValue) : undefined };
}

export async function readContract<T>(source: string, id: string, fn: string, args: xdr.ScVal[] = []): Promise<T> {
  const { simulation } = await simulate(source, new Contract(id).call(fn, ...args));
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) throw new Error(`No return value for ${fn}`);
  return scValToNative(simulation.result.retval) as T;
}

export function tokenBalance(source: string, token: string, owner: string): Promise<bigint> {
  return readContract<bigint>(source, token, "balance", [address(owner)]);
}

export async function hasTrustline(account: string, code: string, issuer: string): Promise<boolean> {
  const response = await fetch(`${stellar.horizonUrl}/accounts/${account}`);
  if (!response.ok) throw new Error(`Horizon ${response.status} for ${account}`);
  const { balances } = (await response.json()) as { balances: { asset_code?: string; asset_issuer?: string }[] };
  return balances.some(line => line.asset_code === code && line.asset_issuer === issuer);
}

/** Opens a trustline with the SAC `trust` function (CAP-73) instead of a classic changeTrust. */
export async function ensureTrustline(key: Keypair, sac: string, issuer: string): Promise<string | null> {
  if (await hasTrustline(key.publicKey(), "USDC", issuer)) return null;
  const { hash } = await invoke(key, new Contract(sac).call("trust", address(key.publicKey())));
  return hash;
}

export function isNonceUsed(source: string, nonce: Hex): Promise<boolean> {
  return readContract<boolean>(source, stellar.messageTransmitter, "is_nonce_used", [bytes(nonce)]);
}

export function mintAndForward(key: Keypair, message: Hex, attestation: Hex): Promise<Invocation> {
  return invoke(key, new Contract(stellar.cctpForwarder).call("mint_and_forward", bytes(message), bytes(attestation)));
}

const swapPath = () => xdr.ScVal.scvVec([address(stellar.circleUsdc), address(stellar.blendUsdc)]);

/** Smallest acceptable output for a swap of `amountIn` (99.5 %, rounded up). */
export function minSwapOut(amountIn: bigint): bigint {
  return (amountIn * MIN_SWAP_OUT_BPS + 9_999n) / 10_000n;
}

export async function quoteCircleToBlend(source: string, amountIn: bigint): Promise<bigint> {
  const amounts = await readContract<bigint[]>(source, stellar.soroswapRouter, "router_get_amounts_out", [i128(amountIn), swapPath()]);
  const out = amounts.at(-1);
  if (out === undefined) throw new Error("Soroswap returned no quote");
  return out;
}

async function swapExact(key: Keypair, amountIn: bigint, minOut: bigint, path: xdr.ScVal): Promise<{ hash: string; amountOut: bigint }> {
  const deadline = nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 600), { type: "u64" });
  const { hash, returnValue } = await invoke(key, new Contract(stellar.soroswapRouter).call(
    "swap_exact_tokens_for_tokens", i128(amountIn), i128(minOut), path, address(key.publicKey()), deadline,
  ));
  const amountOut = (returnValue as bigint[] | undefined)?.at(-1);
  if (amountOut === undefined || amountOut < minOut) throw new Error(`Unexpected swap output in ${hash}`);
  return { hash, amountOut };
}

export async function swapCircleToBlend(key: Keypair, amountIn: bigint): Promise<{ hash: string; amountOut: bigint }> {
  const minOut = minSwapOut(amountIn);
  const quote = await quoteCircleToBlend(key.publicKey(), amountIn);
  if (quote < minOut) throw new Error(`Swap pool too shallow: quote ${quote} below minimum ${minOut}`);
  return swapExact(key, amountIn, minOut, swapPath());
}

export interface PoolReserves {
  circle: bigint;
  blend: bigint;
}

export async function poolReserves(source: string): Promise<PoolReserves> {
  const pair = [address(stellar.circleUsdc), address(stellar.blendUsdc)];
  if (!await readContract<boolean>(source, stellar.soroswapFactory, "pair_exists", pair)) return { circle: 0n, blend: 0n };
  const [circle, blend] = await readContract<[bigint, bigint]>(source, stellar.soroswapRouter, "get_reserves", [address(stellar.soroswapFactory), ...pair]);
  return { circle, blend };
}

/** Output of a Soroswap (Uniswap v2) pair, 0.3 % fee. */
export function pairAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return amountIn * 997n * reserveOut / (reserveIn * 1000n + amountIn * 997n);
}

export interface PegPlan {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minOut: bigint;
}

/** Both tokens are test USDC: the swap that brings the pair back to 1:1, or null within 5 bps. */
export function pegPlan({ circle, blend }: PoolReserves): PegPlan | null {
  if (circle === 0n || blend === 0n) return null;
  const [low, high] = circle < blend ? [circle, blend] : [blend, circle];
  if ((high - low) * 10_000n <= low * 5n) return null;
  // The token with the larger reserve is the cheap one: pay in the other token.
  const circleCheap = circle > blend;
  let lowInput = 0n;
  let highInput = high;
  while (highInput - lowInput > 1n) {
    const mid = (lowInput + highInput) / 2n;
    if (low + mid < high - pairAmountOut(mid, low, high)) lowInput = mid;
    else highInput = mid;
  }
  return {
    tokenIn: circleCheap ? stellar.blendUsdc : stellar.circleUsdc,
    tokenOut: circleCheap ? stellar.circleUsdc : stellar.blendUsdc,
    amountIn: lowInput,
    minOut: pairAmountOut(lowInput, low, high) * 999n / 1000n,
  };
}

export function restorePeg(key: Keypair, plan: PegPlan): Promise<{ hash: string; amountOut: bigint }> {
  return swapExact(key, plan.amountIn, plan.minOut, xdr.ScVal.scvVec([address(plan.tokenIn), address(plan.tokenOut)]));
}

export async function depositToVault(key: Keypair, vault: string, amount: bigint): Promise<{ hash: string; shares: bigint }> {
  const { hash, returnValue } = await invoke(key, new Contract(vault).call("deposit", address(key.publicKey()), i128(amount)));
  if (typeof returnValue !== "bigint" || returnValue <= 0n) throw new Error(`Deposit ${hash} minted no shares`);
  return { hash, shares: returnValue };
}
