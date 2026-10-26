import { Address } from "@stellar/stellar-sdk";
import type { Tsuna } from "@tsuna/sdk";
import { fromUnits } from "./amounts.js";
import type { AssetSymbol } from "./menu.js";

const SCALAR_7 = 10_000_000n;
const SCALAR_12 = 1_000_000_000_000n;
const addr = (value: string) => new Address(value).toScVal();

/** Fields of Blend v2 `Reserve` (`get_reserve`) used by the rate model. */
export interface BlendReserve {
  config: { decimals: number; util: number; r_base: number; r_one: number; r_two: number; r_three: number };
  data: { b_rate: bigint; d_rate: bigint; b_supply: bigint; d_supply: bigint; ir_mod: bigint };
}

export interface ReserveRates {
  utilization: number;
  borrowApr: number;
  supplyApr: number;
  totalSupplied: bigint;
  totalBorrowed: bigint;
}

export const BLEND_RATES_METHOD = "Blend v2 calc_accrual with the stored ir_mod at the current reserve state; supplyApr = borrowApr × utilization × (1 − backstop take rate). Instantaneous annual rates.";

/** Instantaneous Blend v2 rates of a reserve; `bstopRate` is the pool take rate with 7 decimals. */
export function reserveRates(reserve: BlendReserve, bstopRate: number): ReserveRates {
  const { config, data } = reserve;
  const totalSupplied = data.b_supply * data.b_rate / SCALAR_12;
  const totalBorrowed = data.d_supply * data.d_rate / SCALAR_12;
  const util7 = totalSupplied === 0n ? 0n : totalBorrowed * SCALAR_7 / totalSupplied;
  const scale = Number(SCALAR_7);
  const [u, target, base, one, two, three, mod] = [util7, config.util, config.r_base, config.r_one, config.r_two, config.r_three, data.ir_mod]
    .map(value => Number(value) / scale) as [number, number, number, number, number, number, number];
  let borrowApr: number;
  if (u <= target) borrowApr = mod * (base + (target === 0 ? 0 : u / target) * one);
  else if (u <= 0.95) borrowApr = mod * (base + one + (u - target) / (0.95 - target) * two);
  else borrowApr = mod * (base + one + two) + (u - 0.95) / 0.05 * three;
  return { utilization: u, borrowApr, supplyApr: borrowApr * u * (1 - bstopRate / scale), totalSupplied, totalBorrowed };
}

const pct = (rate: number) => `${(rate * 100).toFixed(3)}%`;

/** Venues whose rates are read for a vault. */
export interface RateVenues {
  assets: Record<AssetSymbol, string>;
  blendPool?: string;
  defindexVault?: string;
  aquariusPool?: string;
}

interface ManagedFunds {
  asset: string;
  idle_amount: bigint;
  invested_amount: bigint;
  total_amount: bigint;
  strategy_allocations: { amount: bigint; paused: boolean; strategy_address: string }[];
}

/**
 * Live yield data: Blend reserve rates, the DeFindex vault's allocation (its
 * yield comes from the Blend USDC strategy, scaled by the invested share) and
 * the Aquarius pool state. Every figure is read on-chain now.
 */
export async function readRates(tsuna: Tsuna, venues: RateVenues) {
  const out: Record<string, unknown> = {};
  let usdcSupplyApr: number | undefined;
  if (venues.blendPool) {
    const pool = venues.blendPool;
    const config = await tsuna.read<{ bstop_rate: number }>(pool, "get_config", []);
    const reserves = await Promise.all((Object.entries(venues.assets) as [AssetSymbol, string][]).map(async ([symbol, asset]) => {
      const reserve = await tsuna.read<BlendReserve>(pool, "get_reserve", [addr(asset)]);
      const rates = reserveRates(reserve, config.bstop_rate);
      if (symbol === "USDC") usdcSupplyApr = rates.supplyApr;
      return {
        asset: symbol,
        supplyApr: pct(rates.supplyApr),
        borrowApr: pct(rates.borrowApr),
        utilization: pct(rates.utilization),
        totalSupplied: fromUnits(rates.totalSupplied),
        totalBorrowed: fromUnits(rates.totalBorrowed),
      };
    }));
    out.blend = { pool, backstopTakeRate: pct(config.bstop_rate / Number(SCALAR_7)), reserves, method: BLEND_RATES_METHOD };
  }
  if (venues.defindexVault) {
    const vault = venues.defindexVault;
    const [funds, totalShares, fees] = await Promise.all([
      tsuna.read<ManagedFunds[]>(vault, "fetch_total_managed_funds", []),
      tsuna.read<bigint>(vault, "total_supply", []),
      tsuna.read<[number, number]>(vault, "get_fees", []),
    ]);
    const usdc = funds.find(fund => fund.asset === venues.assets.USDC);
    const investedShare = usdc && usdc.total_amount > 0n ? Number(usdc.invested_amount * 1_000_000n / usdc.total_amount) / 1_000_000 : 0;
    const perShare = totalShares > 0n && usdc ? Number(usdc.total_amount * SCALAR_7 / totalShares) / Number(SCALAR_7) : null;
    out.defindex = {
      vault,
      totalManagedUsdc: usdc ? fromUnits(usdc.total_amount) : "0",
      idleUsdc: usdc ? fromUnits(usdc.idle_amount) : "0",
      investedUsdc: usdc ? fromUnits(usdc.invested_amount) : "0",
      investedShare: pct(investedShare),
      usdcPerShare: perShare,
      feesBps: { vault: fees[0], protocol: fees[1] },
      strategies: (usdc?.strategy_allocations ?? []).map(s => ({ strategy: s.strategy_address, amount: fromUnits(s.amount), paused: s.paused })),
      estimatedApr: usdcSupplyApr === undefined ? null : pct(usdcSupplyApr * investedShare * (1 - fees[0] / 10_000)),
      method: "No rate is published by the DeFindex vault: estimatedApr = Blend USDC supplyApr × invested share × (1 − vault fee). Gross of the strategy's own accounting lag.",
    };
  }
  if (venues.aquariusPool) {
    const pool = venues.aquariusPool;
    const [tokens, reserves, fee, shares] = await Promise.all([
      tsuna.read<string[]>(pool, "get_tokens", []),
      tsuna.read<bigint[]>(pool, "get_reserves", []),
      tsuna.read<number>(pool, "get_fee_fraction", []),
      tsuna.read<bigint>(pool, "get_total_shares", []),
    ]);
    const symbolOf = (token: string) => (Object.entries(venues.assets).find(([, asset]) => asset === token)?.[0]) ?? token;
    out.aquarius = {
      pool,
      reserves: tokens.map((token, index) => ({ asset: symbolOf(token), amount: fromUnits(reserves[index] ?? 0n) })),
      swapFee: pct(fee / 10_000),
      totalShares: fromUnits(shares),
      method: "Pool state only: Aquarius LP income is swap fees (and AQUA rewards), no instantaneous APR is exposed on-chain.",
    };
  }
  return out;
}

/** Oracle router prices (`price_strict`) of the vault assets, in USDC with 7 decimals. */
export async function readPrices(tsuna: Tsuna, assets: Record<AssetSymbol, string>) {
  const entries = await Promise.all((Object.entries(assets) as [AssetSymbol, string][]).map(async ([symbol, asset]) => {
    try {
      return { asset: symbol, priceInUsdc: fromUnits(await tsuna.price(asset)) };
    } catch (error) {
      return { asset: symbol, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { source: "Tsuna oracle router price_strict (Reflector + Chainlink, freshness and deviation checked)", prices: entries };
}
