import { Asset, Keypair, Operation, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ensureBlendUsdc, topUpXlm } from "./pay.js";
import { UNIT, address, balance, byAddress, call, horizon, i128, read, send, testnet, vec } from "./stellar.js";

export const soroswap = {
  router: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  factory: "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY",
  feeBps: 30n,
} as const;
export const aquarius = {
  router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
  /** Pool creation fee token on testnet (`get_init_pool_payment_token`). */
  aqua: "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE",
  aquaIssuer: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
  /** 0.1 %: the 0.3 % XLM/USDC-Blend standard pool already exists and trades far from the oracle. */
  feeFraction: 10,
} as const;
/** XLM kept on the admin account for reserves and fees. */
const XLM_RESERVE = 200n * UNIT;
/**
 * A pool within this distance of the oracle price is left as is. Tight enough that a 0.1 % swap
 * through a 0.3 % fee pool still lands inside a 50 bps tolerance.
 */
const ALIGNED_BPS = 3n;

export const u128 = (value: bigint) => nativeToScVal(value, { type: "u128" });
export const deadline = () => nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 600), { type: "u64" });
export const toAmount = (stroops: bigint) => `${stroops / UNIT}.${(stroops % UNIT).toString().padStart(7, "0")}`;

/** Constant-product output for `amountIn` against reserves `(reserveIn, reserveOut)` with `feeBps`. */
const amountOut = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint) => {
  const net = amountIn * (10_000n - feeBps);
  return net * reserveOut / (reserveIn * 10_000n + net);
};

export interface Swap {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  expectedOut: bigint;
}

/**
 * Smallest swap that moves a USDC/XLM constant-product pool to `price` (USDC units per XLM unit,
 * scaled by 1e7, as `price_strict` returns it), or `null` when it already trades within 10 bps.
 */
export function alignment(usdc: bigint, xlm: bigint, price: bigint, feeBps: bigint): Swap | null {
  const poolPrice = usdc * UNIT / xlm;
  const gap = poolPrice > price ? poolPrice - price : price - poolPrice;
  if (gap * 10_000n <= price * ALIGNED_BPS) return null;
  const buyXlm = poolPrice < price;
  const [reserveIn, reserveOut] = buyXlm ? [usdc, xlm] : [xlm, usdc];
  const reached = (amountIn: bigint) => {
    const out = amountOut(amountIn, reserveIn, reserveOut, feeBps);
    return buyXlm ? (usdc + amountIn) * UNIT >= price * (xlm - out) : (usdc - out) * UNIT <= price * (xlm + amountIn);
  };
  let [low, high] = [0n, reserveIn * 4n];
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (reached(mid)) high = mid;
    else low = mid;
  }
  return {
    tokenIn: buyXlm ? testnet.usdc : testnet.xlm,
    tokenOut: buyXlm ? testnet.xlm : testnet.usdc,
    amountIn: high,
    expectedOut: amountOut(high, reserveIn, reserveOut, feeBps),
  };
}

/** Funds `key` for a swap or deposit: USDC-Blend borrowed on Blend, XLM from Friendbot. */
export async function fund(key: Keypair, asset: string, amount: bigint): Promise<void> {
  if (asset === testnet.usdc) await ensureBlendUsdc(key, amount);
  else await topUpXlm(key, amount + XLM_RESERVE);
}

export async function soroswapReserves(key: Keypair, pair: string): Promise<{ usdc: bigint; xlm: bigint }> {
  const [token0, [reserve0, reserve1]] = await Promise.all([
    read<string>(key, pair, "token_0"),
    read<[bigint, bigint]>(key, pair, "get_reserves"),
  ]);
  return token0 === testnet.usdc ? { usdc: reserve0, xlm: reserve1 } : { usdc: reserve1, xlm: reserve0 };
}

/** Swaps on the Soroswap XLM/USDC-Blend pair until it trades at `price`; returns the swap hash, if any. */
export async function alignSoroswap(key: Keypair, pair: string, price: bigint): Promise<string | null> {
  const { usdc, xlm } = await soroswapReserves(key, pair);
  const swap = alignment(usdc, xlm, price, soroswap.feeBps);
  if (!swap) return null;
  await fund(key, swap.tokenIn, swap.amountIn);
  const swapped = await send(key, call(soroswap.router, "swap_exact_tokens_for_tokens", [
    i128(swap.amountIn), i128(swap.expectedOut * 99n / 100n), vec([address(swap.tokenIn), address(swap.tokenOut)]),
    address(key.publicKey()), deadline(),
  ]));
  const after = await soroswapReserves(key, pair);
  console.log(`SOROSWAP_ALIGN ${toAmount(swap.amountIn)} in ${swap.tokenIn === testnet.usdc ? "USDC" : "XLM"} price=${after.usdc * UNIT / after.xlm} oracle=${price} ${swapped.txHash}`);
  return swapped.txHash;
}

/** Adds liquidity at the pair's ratio until its USDC reserve reaches `depth`. */
export async function deepenSoroswap(key: Keypair, pair: string, depth: bigint): Promise<string | null> {
  const { usdc, xlm } = await soroswapReserves(key, pair);
  if (usdc * 100n >= depth * 99n) return null;
  const addUsdc = depth - usdc;
  const addXlm = addUsdc * xlm / usdc + 1n;
  await fund(key, testnet.usdc, addUsdc);
  await fund(key, testnet.xlm, addXlm);
  const added = await send(key, call(soroswap.router, "add_liquidity", [
    address(testnet.usdc), address(testnet.xlm), i128(addUsdc), i128(addXlm),
    i128(addUsdc * 99n / 100n), i128(addXlm * 99n / 100n), address(key.publicKey()), deadline(),
  ]));
  console.log(`SOROSWAP_ADD_LIQUIDITY usdc=${toAmount(addUsdc)} xlm=${toAmount(addXlm)} ${added.txHash}`);
  return added.txHash;
}

/** Aquarius identifies a pool by its sorted token list and a 32-byte index. */
export const aquariusTokens = () => [testnet.usdc, testnet.xlm].sort(byAddress);

export interface AquariusPool {
  pool: string;
  index: string;
  createTx?: string;
  trustTx?: string;
  buyTx?: string;
}

async function hasAquaTrustline(owner: string): Promise<boolean> {
  const account = await horizon.loadAccount(owner);
  return account.balances.some(line => "asset_issuer" in line && line.asset_issuer === aquarius.aquaIssuer && "asset_code" in line && line.asset_code === "AQUA");
}

/**
 * Returns the XLM/USDC-Blend standard pool at `aquarius.feeFraction`, creating it when absent.
 * Creation is paid in AQUA, bought with XLM on the deepest Aquarius AQUA/XLM pool.
 */
export async function ensureAquariusPool(key: Keypair): Promise<AquariusPool> {
  const tokens = vec(aquariusTokens().map(address));
  const pools = await read<Record<string, string>>(key, aquarius.router, "get_pools", [tokens]);
  // `get_pools` keys are 32-byte indexes, decoded by `scValToNative` as comma-separated bytes.
  for (const [index, pool] of Object.entries(pools)) {
    const [kind, fee] = await Promise.all([
      read<string>(key, pool, "pool_type"),
      read<number>(key, pool, "get_fee_fraction"),
    ]);
    if (kind === "constant_product" && fee === aquarius.feeFraction) {
      return { pool, index: Buffer.from(index.split(",").map(Number)).toString("hex") };
    }
  }
  const created: AquariusPool = { pool: "", index: "" };
  const owner = key.publicKey();
  if (!await hasAquaTrustline(owner)) {
    const trust = await send(key, Operation.changeTrust({ asset: new Asset("AQUA", aquarius.aquaIssuer) }), false);
    created.trustTx = trust.txHash;
    console.log(`AQUA_TRUST ${trust.txHash}`);
  }
  const fee = await read<bigint>(key, aquarius.router, "get_standard_pool_payment_amount");
  if (await balance(key, owner, aquarius.aqua) < fee) {
    const pair = vec([testnet.xlm, aquarius.aqua].sort(byAddress).map(address));
    const quotes = await read<Record<string, string>>(key, aquarius.router, "get_pools", [pair]);
    const xlmIn = 10n * UNIT;
    let best: { index: Buffer; out: bigint } | undefined;
    for (const [index, pool] of Object.entries(quotes)) {
      if (await read<string>(key, pool, "pool_type") !== "constant_product") continue;
      const bytes = Buffer.from(index.split(",").map(Number));
      const out = await read<bigint>(key, aquarius.router, "estimate_swap", [
        pair, address(testnet.xlm), address(aquarius.aqua), xdr.ScVal.scvBytes(bytes), u128(xlmIn),
      ]);
      if (!best || out > best.out) best = { index: bytes, out };
    }
    if (!best || best.out < fee * 2n) throw new Error("No Aquarius AQUA/XLM pool sells enough AQUA for the pool creation fee");
    const bought = await send(key, call(aquarius.router, "swap", [
      address(owner), pair, address(testnet.xlm), address(aquarius.aqua), xdr.ScVal.scvBytes(best.index),
      u128(xlmIn), u128(fee),
    ]));
    created.buyTx = bought.txHash;
    console.log(`AQUA_BUY ${toAmount(best.out)} for ${toAmount(xlmIn)} XLM ${bought.txHash}`);
  }
  const init = await send(key, call(aquarius.router, "init_standard_pool", [
    address(owner), tokens, nativeToScVal(aquarius.feeFraction, { type: "u32" }),
  ]));
  if (!init.returnValue) throw new Error(`Aquarius pool creation ${init.txHash} returned nothing`);
  const [bytes, pool] = scValToNative(init.returnValue) as [Uint8Array, string];
  const index = Buffer.from(bytes).toString("hex");
  console.log(`AQUARIUS_POOL ${pool} index=${index} fee=${aquarius.feeFraction} ${init.txHash}`);
  return { ...created, pool, index, createTx: init.txHash };
}

export async function aquariusReserves(key: Keypair, pool: string): Promise<{ usdc: bigint; xlm: bigint }> {
  const [tokens, reserves] = await Promise.all([
    read<string[]>(key, pool, "get_tokens"),
    read<bigint[]>(key, pool, "get_reserves"),
  ]);
  const at = (asset: string) => reserves[tokens.indexOf(asset)] ?? 0n;
  return { usdc: at(testnet.usdc), xlm: at(testnet.xlm) };
}

/**
 * Brings the Aquarius pool to `price` (swap when it holds liquidity) and its USDC reserve to
 * `depth` (deposit at the oracle ratio when empty, at the pool ratio otherwise).
 */
export async function seedAquarius(key: Keypair, { pool, index }: AquariusPool, price: bigint, depth: bigint) {
  const owner = key.publicKey();
  const tokens = aquariusTokens();
  const poolIndex = xdr.ScVal.scvBytes(Buffer.from(index, "hex"));
  let reserves = await aquariusReserves(key, pool);
  let alignTx: string | undefined;
  if (reserves.usdc > 0n && reserves.xlm > 0n) {
    const swap = alignment(reserves.usdc, reserves.xlm, price, BigInt(aquarius.feeFraction));
    if (swap) {
      await fund(key, swap.tokenIn, swap.amountIn);
      const swapped = await send(key, call(aquarius.router, "swap", [
        address(owner), vec(tokens.map(address)), address(swap.tokenIn), address(swap.tokenOut), poolIndex,
        u128(swap.amountIn), u128(swap.expectedOut * 99n / 100n),
      ]));
      alignTx = swapped.txHash;
      reserves = await aquariusReserves(key, pool);
      console.log(`AQUARIUS_ALIGN price=${reserves.usdc * UNIT / reserves.xlm} oracle=${price} ${swapped.txHash}`);
    }
  }
  let depositTx: string | undefined;
  if (reserves.usdc * 100n < depth * 99n) {
    const addUsdc = depth - reserves.usdc;
    const addXlm = reserves.usdc > 0n ? addUsdc * reserves.xlm / reserves.usdc + 1n : addUsdc * UNIT / price;
    await fund(key, testnet.usdc, addUsdc);
    await fund(key, testnet.xlm, addXlm);
    const amounts = tokens.map(token => u128(token === testnet.usdc ? addUsdc : addXlm));
    const deposited = await send(key, call(aquarius.router, "deposit", [
      address(owner), vec(tokens.map(address)), poolIndex, vec(amounts), u128(0n),
    ]));
    depositTx = deposited.txHash;
    reserves = await aquariusReserves(key, pool);
    console.log(`AQUARIUS_DEPOSIT usdc=${toAmount(addUsdc)} xlm=${toAmount(addXlm)} ${deposited.txHash}`);
  }
  console.log(`AQUARIUS_RESERVES usdc=${toAmount(reserves.usdc)} xlm=${toAmount(reserves.xlm)} price=${reserves.usdc * UNIT / reserves.xlm} oracle=${price}`);
  return { alignTx, depositTx };
}
