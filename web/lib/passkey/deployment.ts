import deployment from "../../../deployments/passkey.testnet.json";

/** Public addresses of the passkey stack on Stellar testnet. */
export const passkeyDeployment = {
  relayer: deployment.relayer,
  faucet: deployment.faucet,
  usdc: deployment.usdc,
  verifier: deployment.verifier,
  accountWasmHash: deployment.accountWasmHash,
} as const;

export const USDC_DECIMALS = 7;
export const EXPLORER_URL = "https://stellar.expert/explorer/testnet";

/** Formats a seven-decimal token amount for display, e.g. `1,000.00`. */
export function formatUsdc(units: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = units / scale;
  const cents = (units % scale) / 10n ** BigInt(USDC_DECIMALS - 2);
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}
