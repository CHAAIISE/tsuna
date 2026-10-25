/** Every vault asset, Blend reserve, DeFindex share and Aquarius share used by Leash has 7 decimals. */
export const DECIMALS = 7;
const SCALE = 10n ** BigInt(DECIMALS);

/** Decimal token amount as written by the model ("25", "0.5", "12.3456789"). */
export const DECIMAL_AMOUNT = /^\d+(\.\d{1,7})?$/;

/** Parses a decimal token amount into base units; throws on any other format. */
export function toUnits(amount: string): bigint {
  if (!DECIMAL_AMOUNT.test(amount)) throw new Error(`Invalid amount "${amount}": use a decimal number with up to ${DECIMALS} decimals`);
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(DECIMALS, "0"));
}

/** Formats base units as a decimal token amount, without trailing zeros. */
export function fromUnits(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const fraction = (abs % SCALE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${sign}${abs / SCALE}${fraction ? `.${fraction}` : ""}`;
}
