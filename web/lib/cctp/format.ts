/** Exact decimal rendering of a USDC integer amount (6 decimals for CCTP, 7 on Stellar). */
export function formatUsdc(amount: bigint, decimals: 6 | 7): string {
  const scale = 10n ** BigInt(decimals);
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${abs / scale}${fraction ? `.${fraction}` : ""}`;
}
