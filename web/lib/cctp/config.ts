/**
 * CCTP V2 testnet addresses (Ethereum Sepolia → Stellar testnet), checked against
 * https://skills.stellar.org/skills/cross-chain/cctp.md and the live contracts.
 */
export const cctp = {
  irisApi: "https://iris-api-sandbox.circle.com",
  sepoliaDomain: 0,
  stellarDomain: 27,
  /** Fast transfer; the fee for it is read from Iris before each burn. */
  minFinalityThreshold: 1000,
} as const;

export const sepolia = {
  chainId: 11155111,
  /** Circle `TokenMessengerV2`, same address on every EVM testnet. */
  messengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  explorer: "https://sepolia.etherscan.io",
} as const;

export const stellar = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorer: "https://stellar.expert/explorer/testnet",
  messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
  cctpForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  /** Circle testnet USDC, what CCTP mints on Stellar. */
  circleUsdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  circleUsdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  /** Blend testnet USDC, the vault's base asset. */
  blendUsdc: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
  blendUsdcIssuer: "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56",
  soroswapRouter: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
  soroswapFactory: "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY",
} as const;

/** USDC amount bridged per run, in CCTP's six-decimal units (1 USDC). */
export const BRIDGE_AMOUNT = 1_000_000n;
/** The swap must return at least 99.5 % of its input. */
export const MIN_SWAP_OUT_BPS = 9_950n;
