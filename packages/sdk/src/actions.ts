import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { TESTNET } from "./network.js";

/** One call the vault makes as actor: `target.fn(args)`. */
export interface Call {
  target: string;
  fn: string;
  args: xdr.ScVal[];
}

/** Blend `submit` request types. */
export const BlendRequest = {
  Supply: 0,
  Withdraw: 1,
  SupplyCollateral: 2,
  WithdrawCollateral: 3,
  Borrow: 4,
  Repay: 5,
} as const;
export type BlendRequestType = (typeof BlendRequest)[keyof typeof BlendRequest];

/** Seconds a swap stays executable. */
const SWAP_DEADLINE_SECS = 600n;

const address = (value: string) => new Address(value).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const u128 = (value: bigint) => nativeToScVal(value, { type: "u128" });
const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: nativeToScVal(key, { type: "symbol" }), val });

/** Blend `Request { address, amount, request_type }`, fields in host order. */
export function blendRequestVal(asset: string, amount: bigint, type: BlendRequestType): xdr.ScVal {
  return xdr.ScVal.scvMap([
    field("address", address(asset)),
    field("amount", i128(amount)),
    field("request_type", nativeToScVal(type, { type: "u32" })),
  ]);
}

/**
 * Blend `submit_with_allowance(vault, vault, vault, [request])`. The vault's rule for it sets
 * `approve`, so the vault itself approves the pool for the exact inflow and checks the
 * allowance is consumed: no separate `approve` call is needed.
 */
function blend(vault: string, asset: string, amount: bigint, type: BlendRequestType, pool: string): Call[] {
  return [{
    target: pool,
    fn: "submit_with_allowance",
    args: [address(vault), address(vault), address(vault), xdr.ScVal.scvVec([blendRequestVal(asset, amount, type)])],
  }];
}

/** Call builders with the exact arguments each protocol takes; amounts are raw base units. */
export const actions = {
  blendSupply: (vault: string, asset: string, amount: bigint, pool: string = TESTNET.blendPool) =>
    blend(vault, asset, amount, BlendRequest.Supply, pool),
  blendWithdraw: (vault: string, asset: string, amount: bigint, pool: string = TESTNET.blendPool) =>
    blend(vault, asset, amount, BlendRequest.Withdraw, pool),
  blendSupplyCollateral: (vault: string, asset: string, amount: bigint, pool: string = TESTNET.blendPool) =>
    blend(vault, asset, amount, BlendRequest.SupplyCollateral, pool),
  blendWithdrawCollateral: (vault: string, asset: string, amount: bigint, pool: string = TESTNET.blendPool) =>
    blend(vault, asset, amount, BlendRequest.WithdrawCollateral, pool),
  blendBorrow: (vault: string, asset: string, amount: bigint, pool: string = TESTNET.blendPool) =>
    blend(vault, asset, amount, BlendRequest.Borrow, pool),
  blendRepay: (vault: string, asset: string, amount: bigint, pool: string = TESTNET.blendPool) =>
    blend(vault, asset, amount, BlendRequest.Repay, pool),

  /** DeFindex `deposit([amount], [0], vault, invest)`; the vault authorizes the exact transfer itself. */
  defindexDeposit: (vault: string, defindex: string, amount: bigint, invest = true): Call[] => [{
    target: defindex,
    fn: "deposit",
    args: [xdr.ScVal.scvVec([i128(amount)]), xdr.ScVal.scvVec([i128(0n)]), address(vault), xdr.ScVal.scvBool(invest)],
  }],
  /** DeFindex `withdraw(shares, [0], vault)` for a single-asset DeFindex vault; NAV checks bound the output. */
  defindexWithdraw: (vault: string, defindex: string, shares: bigint): Call[] => [{
    target: defindex,
    fn: "withdraw",
    args: [i128(shares), xdr.ScVal.scvVec([i128(0n)]), address(vault)],
  }],

  /** Soroswap `swap_exact_tokens_for_tokens(amountIn, minOut, path, vault, now + 10 min)`. */
  soroswapSwap: (
    vault: string, path: string[], amountIn: bigint, minOut: bigint,
    router: string = TESTNET.soroswapRouter, now: Date = new Date(),
  ): Call[] => [{
    target: router,
    fn: "swap_exact_tokens_for_tokens",
    args: [
      i128(amountIn), i128(minOut), xdr.ScVal.scvVec(path.map(address)), address(vault),
      nativeToScVal(BigInt(Math.floor(now.getTime() / 1000)) + SWAP_DEADLINE_SECS, { type: "u64" }),
    ],
  }],

  /** Aquarius pool `deposit(vault, desired_amounts, min_shares)`; amounts ordered like the pool's `get_tokens()`. */
  aquariusDeposit: (vault: string, pool: string, amounts: bigint[], minShares: bigint): Call[] => [{
    target: pool,
    fn: "deposit",
    args: [address(vault), xdr.ScVal.scvVec(amounts.map(u128)), u128(minShares)],
  }],
  /** Aquarius pool `withdraw(vault, share_amount, min_amounts)`. */
  aquariusWithdraw: (vault: string, pool: string, shares: bigint, minAmounts: bigint[]): Call[] => [{
    target: pool,
    fn: "withdraw",
    args: [address(vault), u128(shares), xdr.ScVal.scvVec(minAmounts.map(u128))],
  }],

  /** SAC `transfer(vault, to, amount)`: no vault policy allowlists it, so the vault refuses it. */
  usdcTransfer: (vault: string, to: string, amount: bigint, usdc: string = TESTNET.usdc): Call[] => [{
    target: usdc,
    fn: "transfer",
    args: [address(vault), address(to), i128(amount)],
  }],
};
