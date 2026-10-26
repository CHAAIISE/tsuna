import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { readContract } from "./soroban";

/** Reflector external CEX/DEX feed on testnet, quoted in USD. */
export const REFLECTOR = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const SECONDS_PER_YEAR = 365 * 24 * 3600;
const HOURS = 24;
/** The testnet feed returns null for long `prices` reads (24+ records); 13 cover at least the last hour at 5-minute resolution. */
const RECENT_RECORDS = 13;

export interface PricePoint {
  price: bigint;
  timestamp: bigint;
}

export interface RiskInput {
  decimals: number;
  resolution: number;
  /** Most recent first, as returned by `prices`. */
  recent: PricePoint[];
  /** Price at the latest timestamp minus 1..24 hours; missing points are beyond retention. */
  hourly: (PricePoint | null)[];
  usdc: PricePoint;
}

export const RISK_THRESHOLDS = {
  elevated: { absChange24h: 0.05, annualizedVolatility: 0.8 },
  high: { absChange24h: 0.1, annualizedVolatility: 1.5 },
} as const;

export const RISK_METHOD = [
  "Prices come from the Reflector oracle (lastprice, prices, price at past timestamps), quoted in USD.",
  "change1h and changeWindow compare the latest XLM price with the price one hour ago and with the oldest hourly point still retained (up to 24 h).",
  "Volatility is the sample standard deviation of log returns, annualized with sqrt(periods per year): 5-minute returns over the last hour and hourly returns over the window.",
  `level is "high" when |changeWindow| >= ${RISK_THRESHOLDS.high.absChange24h * 100}% or either volatility >= ${RISK_THRESHOLDS.high.annualizedVolatility * 100}%, "elevated" at ${RISK_THRESHOLDS.elevated.absChange24h * 100}% / ${RISK_THRESHOLDS.elevated.annualizedVolatility * 100}%, otherwise "low".`,
  "usdcPegDeviationBps is (USDC price - 1 USD) in basis points.",
].join(" ");

function annualizedVolatility(prices: number[], periodSeconds: number): number | null {
  const returns = prices.slice(1).map((price, index) => Math.log(price / (prices[index] as number)));
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(SECONDS_PER_YEAR / periodSeconds);
}

export function riskSignal(input: RiskInput) {
  const scale = 10 ** input.decimals;
  const value = (point: PricePoint) => Number(point.price) / scale;
  const [latest] = input.recent;
  if (!latest) throw new Error("Reflector returned no recent XLM price");
  const chronological = [...input.recent].reverse().map(value);
  const retained = input.hourly.flatMap((point, index) => point ? [{ hoursAgo: index + 1, point }] : []);
  const oldest = retained.at(-1);
  const hourAgo = input.hourly[0];
  const hourlySeries = [...retained].reverse().map(({ point }) => value(point)).concat(value(latest));
  const change1h = hourAgo ? value(latest) / value(hourAgo) - 1 : null;
  const changeWindow = oldest ? value(latest) / value(oldest.point) - 1 : null;
  const volatility5m = annualizedVolatility(chronological, input.resolution);
  const volatilityHourly = annualizedVolatility(hourlySeries, 3600);
  const exceeds = (limits: { absChange24h: number; annualizedVolatility: number }) =>
    (changeWindow !== null && Math.abs(changeWindow) >= limits.absChange24h)
    || [volatility5m, volatilityHourly].some(vol => vol !== null && vol >= limits.annualizedVolatility);
  return {
    asset: "XLM",
    quote: "USD",
    price: value(latest),
    priceTimestamp: Number(latest.timestamp),
    change1h,
    changeWindow: oldest ? { hours: oldest.hoursAgo, change: changeWindow } : null,
    volatility: {
      fiveMinuteAnnualized: volatility5m,
      fiveMinuteReturns: Math.max(chronological.length - 1, 0),
      hourlyAnnualized: volatilityHourly,
      hourlyReturns: Math.max(hourlySeries.length - 1, 0),
    },
    usdcPegDeviationBps: (value(input.usdc) - 1) * 10_000,
    level: exceeds(RISK_THRESHOLDS.high) ? "high" : exceeds(RISK_THRESHOLDS.elevated) ? "elevated" : "low",
  };
}

const other = (symbol: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(symbol)]);

export async function reflectorRiskSignal() {
  const xlm = other("XLM");
  const [decimals, resolution, last, recent, usdc] = await Promise.all([
    readContract<number>(REFLECTOR, "decimals"),
    readContract<number>(REFLECTOR, "resolution"),
    readContract<bigint>(REFLECTOR, "last_timestamp"),
    readContract<PricePoint[] | null>(REFLECTOR, "prices", [xlm, nativeToScVal(RECENT_RECORDS, { type: "u32" })]),
    readContract<PricePoint | null>(REFLECTOR, "lastprice", [other("USDC")]),
  ]);
  if (!recent.value || !usdc.value) throw new Error("Reflector has no recent XLM or USDC price");
  const hourly = await Promise.all(Array.from({ length: HOURS }, (_, index) =>
    readContract<PricePoint | null>(REFLECTOR, "price", [xlm, nativeToScVal(last.value - BigInt((index + 1) * 3600), { type: "u64" })])
      .then(point => point.value)));
  return {
    oracle: REFLECTOR,
    network: "stellar:testnet",
    ledger: Math.max(decimals.ledger, recent.ledger, usdc.ledger),
    resolutionSeconds: resolution.value,
    ...riskSignal({ decimals: decimals.value, resolution: resolution.value, recent: recent.value, hourly, usdc: usdc.value }),
    method: RISK_METHOD,
  };
}
