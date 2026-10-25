/**
 * Choices offered by /create. Plain data shared by the form and the server route: the server
 * turns a validated choice into a policy with the SDK presets, the form never sends rules.
 */

export type StrategyId = "yield" | "leverage" | "liquidity";
export type AdapterKind = "Blend" | "DeFindex" | "Aquarius" | "Soroswap";
export type AssetSymbol = "USDC" | "XLM";

/** One protocol of a strategy with the presets it grants. */
export interface StrategyVenue {
  id: string;
  label: string;
  /** SDK preset ids; Blend actions share one entry point, so they come as one venue. */
  presets: string[];
  adapter: AdapterKind;
  /** The creator may leave it out (at least one venue stays). */
  optional: boolean;
}

export interface Strategy {
  id: StrategyId;
  label: string;
  summary: string;
  /** Base asset first. */
  assets: AssetSymbol[];
  venues: StrategyVenue[];
  /** A volatile asset is involved: 50 bps loss tolerance per call instead of 10. */
  volatile: boolean;
  /** The strategy borrows: the health-factor floor applies. */
  borrows: boolean;
}

export const STRATEGIES: Strategy[] = [
  {
    id: "yield",
    label: "Stablecoin yield",
    summary: "Lends USDC on Blend and through a DeFindex vault that lends on Blend. Stablecoins only.",
    assets: ["USDC"],
    venues: [
      { id: "blend", label: "Blend lending", presets: ["blend.supply", "blend.withdraw"], adapter: "Blend", optional: true },
      { id: "defindex", label: "DeFindex vault", presets: ["defindex.deposit", "defindex.withdraw"], adapter: "DeFindex", optional: true },
    ],
    volatile: false,
    borrows: false,
  },
  {
    id: "leverage",
    label: "Leveraged XLM",
    summary: "Holds XLM as Blend collateral, borrows USDC against it and swaps on Soroswap.",
    assets: ["USDC", "XLM"],
    venues: [
      { id: "blend", label: "Blend collateral and borrowing", presets: ["blend.supply", "blend.withdraw", "blend.borrow", "blend.repay"], adapter: "Blend", optional: false },
      { id: "soroswap", label: "Soroswap swaps", presets: ["soroswap.swap"], adapter: "Soroswap", optional: false },
    ],
    volatile: true,
    borrows: true,
  },
  {
    id: "liquidity",
    label: "Liquidity provision",
    summary: "Provides XLM/USDC liquidity on Aquarius and buys its XLM inventory on Soroswap.",
    assets: ["USDC", "XLM"],
    venues: [
      { id: "aquarius", label: "Aquarius XLM/USDC pool", presets: ["aquarius.deposit", "aquarius.withdraw"], adapter: "Aquarius", optional: false },
      { id: "soroswap", label: "Soroswap swaps", presets: ["soroswap.swap"], adapter: "Soroswap", optional: false },
    ],
    volatile: true,
    borrows: false,
  },
];

export interface Option<T extends string | number> {
  value: T;
  label: string;
}

/** Share of NAV the vault may lose over 24 h before every further call is refused. */
export const DAILY_LOSS_OPTIONS: Option<number>[] = [
  { value: 25, label: "0.25 %" },
  { value: 50, label: "0.5 %" },
  { value: 100, label: "1 %" },
];

/** Drop from the 24 h peak of the share price at which anyone can pause the vault. */
export const DRAWDOWN_OPTIONS: Option<number>[] = [
  { value: 1_000, label: "10 %" },
  { value: 2_000, label: "20 %" },
];

/** `vault`: the vault-wide limit applies (no per-protocol caps); `capped`: each position protocol at 60 %. */
export const EXPOSURE_OPTIONS: Option<"vault" | "capped">[] = [
  { value: "vault", label: "50 % of NAV in any protocol" },
  { value: "capped", label: "60 % per position protocol" },
];

/** Per-protocol cap of the `capped` choice, in bps (as on the demo vaults). */
export const PROTOCOL_CAP_BPS = 6_000;

export interface CreateChoice {
  strategy: StrategyId;
  /** Venue ids of the strategy to grant (optional ones may be left out). */
  venues: string[];
  dailyLossBps: number;
  drawdownBps: number;
  exposure: "vault" | "capped";
  riskOff: boolean;
}

export interface PresetInfo {
  id: string;
  label: string;
  description: string;
}
