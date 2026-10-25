import { Address } from "@stellar/stellar-sdk";
import { readContract } from "./soroban";

export const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const RESERVES = [
  { symbol: "USDC", asset: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU" },
  { symbol: "XLM", asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" },
] as const;

const SCALAR_7 = 10_000_000n;
const SCALAR_12 = 1_000_000_000_000n;

/** Fields of Blend v2 `Reserve` (`get_reserve`) used by the rate model. */
export interface BlendReserve {
  config: { decimals: number; util: number; r_base: number; r_one: number; r_two: number; r_three: number };
  data: { b_rate: bigint; d_rate: bigint; b_supply: bigint; d_supply: bigint; ir_mod: bigint; last_time: bigint };
}

export interface ReserveRates {
  utilization: number;
  borrowApr: number;
  supplyApr: number;
  totalSupplied: bigint;
  totalBorrowed: bigint;
}

export const RATES_METHOD = [
  "Reserve state is read with get_reserve and get_config on the Blend v2 pool at the reported ledger.",
  "totalSupplied = b_supply * b_rate / 1e12 and totalBorrowed = d_supply * d_rate / 1e12 (asset units); utilization = totalBorrowed / totalSupplied.",
  "borrowApr follows Blend v2 calc_accrual with the stored ir_mod: U <= target: ir_mod * (r_base + U/target * r_one); U <= 95%: ir_mod * (r_base + r_one + (U - target)/(95% - target) * r_two); above: ir_mod * (r_base + r_one + r_two) + (U - 95%)/5% * r_three.",
  "supplyApr = borrowApr * utilization * (1 - bstop_rate): lenders receive the interest paid by borrowers minus the backstop take rate.",
  "Rates are instantaneous annual rates at the current state; Blend updates ir_mod on the next accrual.",
].join(" ");

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

const units = (value: bigint, decimals: number) => {
  const scale = 10n ** BigInt(decimals);
  return `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
};

export async function blendRatesSignal() {
  const [config, reserves] = await Promise.all([
    readContract<{ bstop_rate: number }>(BLEND_POOL, "get_config"),
    Promise.all(RESERVES.map(async ({ symbol, asset }) => ({
      symbol, asset, ...await readContract<BlendReserve>(BLEND_POOL, "get_reserve", [new Address(asset).toScVal()]),
    }))),
  ]);
  return {
    pool: BLEND_POOL,
    network: "stellar:testnet",
    ledger: Math.max(config.ledger, ...reserves.map(reserve => reserve.ledger)),
    backstopTakeRate: config.value.bstop_rate / Number(SCALAR_7),
    reserves: reserves.map(({ symbol, asset, value: reserve }) => {
      const rates = reserveRates(reserve, config.value.bstop_rate);
      return {
        symbol,
        asset,
        bRate: reserve.data.b_rate.toString(),
        dRate: reserve.data.d_rate.toString(),
        bSupply: reserve.data.b_supply.toString(),
        dSupply: reserve.data.d_supply.toString(),
        irModifier: Number(reserve.data.ir_mod) / Number(SCALAR_7),
        targetUtilization: reserve.config.util / Number(SCALAR_7),
        lastAccrualTime: Number(reserve.data.last_time),
        totalSupplied: units(rates.totalSupplied, reserve.config.decimals),
        totalBorrowed: units(rates.totalBorrowed, reserve.config.decimals),
        utilization: rates.utilization,
        borrowApr: rates.borrowApr,
        supplyApr: rates.supplyApr,
      };
    }),
    method: RATES_METHOD,
  };
}
