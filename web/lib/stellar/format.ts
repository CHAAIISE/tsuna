/** Display helpers shared by the server mappers and the app screens. Pure, no Stellar SDK. */

export const EXPLORER = "https://stellar.expert/explorer/testnet";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAccount = (address: string) =>
  `${EXPLORER}/${address.startsWith("C") ? "contract" : "account"}/${address}`;

export const BASE_DECIMALS = 7;
/** Raw vault shares per base unit at inception (the contract's virtual share offset, 10^9). */
const SHARE_OFFSET = 1_000_000_000n;
const PPS_SCALE = 10n ** 18n;
/** One displayed share: worth one USDC at inception (10^9 raw shares × 10^7 units). */
export const SHARE_UNIT = SHARE_OFFSET * 10n ** BigInt(BASE_DECIMALS);

export const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

const big = (value: string | bigint) => typeof value === "bigint" ? value : BigInt(value);

/** `units` with `decimals` decimals, grouped, rounded toward zero to `digits` decimals. */
export function formatUnits(value: string | bigint, decimals = BASE_DECIMALS, digits = 2): string {
  const units = big(value);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const shown = Math.min(digits, decimals);
  const fraction = (abs % scale) / 10n ** BigInt(decimals - shown);
  const text = `${whole.toLocaleString("en-US")}${shown > 0 ? `.${fraction.toString().padStart(shown, "0")}` : ""}`;
  return negative && (whole > 0n || fraction > 0n) ? `−${text}` : text;
}

/** USDC amount from base units, e.g. `3,000.00`. */
export const formatUsdc = (units: string | bigint, digits = 2) => formatUnits(units, BASE_DECIMALS, digits);

/** Compact USDC amount for KPIs, e.g. `7.0K`. Exact below 10,000. */
export function formatUsdcCompact(units: string | bigint): string {
  const whole = Number(big(units) / 10n ** BigInt(BASE_DECIMALS));
  if (Math.abs(whole) < 10_000) return formatUsdc(units);
  if (Math.abs(whole) < 1_000_000) return `${(whole / 1_000).toFixed(1)}K`;
  return `${(whole / 1_000_000).toFixed(2)}M`;
}

/** Parses a decimal USDC amount typed by a user into base units; null when invalid. */
export function parseUsdc(text: string): bigint | null {
  const match = /^\s*(\d{1,12})(?:\.(\d{0,7}))?\s*$/.exec(text.replace(/,/g, ""));
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * 10n ** BigInt(BASE_DECIMALS) + BigInt(fraction.padEnd(BASE_DECIMALS, "0") || "0");
}

/** Value in base units of `shares` raw vault shares at price per share `pps` (scaled 10^18). */
export const sharesValue = (shares: string | bigint, pps: string | bigint) => big(shares) * big(pps) / PPS_SCALE;

/** Raw shares worth at most `units` at `pps` (rounded down, never more than owned). */
export function sharesFor(units: bigint, pps: string | bigint, owned: string | bigint): bigint {
  const price = big(pps);
  if (price <= 0n) return 0n;
  const shares = units * PPS_SCALE / price;
  const max = big(owned);
  return shares > max ? max : shares;
}

/** NAV per displayed share (one USDC at inception), e.g. `1.000004`. */
export function formatSharePrice(pps: string | bigint, digits = 6): string {
  return formatUnits(big(pps) * SHARE_UNIT / PPS_SCALE, BASE_DECIMALS, digits);
}

/** Displayed share count (one share = one USDC at inception). */
export const formatShares = (shares: string | bigint, digits = 4) => formatUnits(big(shares), 16, digits);

/** Basis points as a signed percentage; small values keep enough decimals to be non-zero. */
export function formatBps(bps: number, { signed = true }: { signed?: boolean } = {}): string {
  const percent = bps / 100;
  const abs = Math.abs(percent);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  const text = abs.toFixed(digits);
  if (Number(text) === 0) return "0.00%";
  const sign = percent < 0 ? "−" : signed ? "+" : "";
  return `${sign}${text}%`;
}

/** Plain bps limit as a percentage, e.g. 5000 → `50%`, 50 → `0.5%`. */
export function formatLimitBps(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(percent < 1 ? 2 : 1)}%`;
}

/** Elapsed time since `seconds` (epoch), e.g. `45 min`, `5 h`, `3 d`. */
export function formatAge(seconds: number, now = Date.now() / 1000): string {
  const elapsed = Math.max(0, now - seconds);
  if (elapsed < 3_600) return `${Math.max(1, Math.round(elapsed / 60))} min`;
  if (elapsed < 172_800) return `${Math.round(elapsed / 3_600)} h`;
  return `${Math.round(elapsed / 86_400)} d`;
}

/** Health factor in bps (10,000 = 1.00) as a ratio, e.g. `2.04`. */
export const formatHealth = (bps: string | bigint) => (Number(big(bps)) / 10_000).toFixed(2);

/** Short relative time for timelines, e.g. `just now`, `4 min ago`, `Oct 25, 21:03`. */
export function formatWhen(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const seconds = Math.round((now - at.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`;
  return at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * SVG path of a sparkline through `values`, scaled into `width` × `height` with
 * `pad` pixels of vertical margin. A flat series is drawn at mid-height.
 */
export function sparklinePath(values: number[], width: number, height: number, pad = 2): string {
  if (values.length === 0) return "";
  const series = values.length === 1 ? [values[0] as number, values[0] as number] : values;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const step = width / (series.length - 1);
  return series.map((value, i) => {
    const y = span === 0 ? height / 2 : pad + (1 - (value - min) / span) * (height - 2 * pad);
    return `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

/** Relative price-per-share series for a sparkline (precision kept on tiny moves). */
export function ppsSeries(points: { pps: string }[]): number[] {
  const first = points[0];
  if (!first) return [];
  const base = big(first.pps);
  if (base === 0n) return points.map(() => 0);
  return points.map(point => Number((big(point.pps) - base) * 1_000_000_000n / base));
}
