/**
 * JSON shapes the vault API routes return. Contract integers (i128) travel as
 * decimal strings; amounts are base-asset units (USDC, 7 decimals) unless named
 * otherwise.
 */

/** A contract error, named and explained by `@tsuna/sdk`. */
export interface TypedError {
  contract: string;
  code: number;
  name: string;
  message: string;
}

export interface SnapshotPoint {
  /** Ledger close time, seconds since the epoch. */
  ts: number;
  /** Price per share scaled by 10^18. */
  pps: string;
}

export interface RuleCount {
  /** Allowlisted `(contract, function)` pairs across every role. */
  calls: number;
  /** Vault-wide limits of the policy (caps, rate, loss budget, drawdown, exposure, health floor). */
  limits: number;
  total: number;
}

export interface AgentRow {
  address: string;
  /** Route segment: the deployment slug when the vault has one, else its address. */
  id: string;
  name: string;
  /** Vaults of the Tsuna demo fleet (`deployments/testnet.json`). */
  featured: boolean;
  strategyId: string | null;
  strategy: string | null;
  creator: string;
  nav: string | null;
  pps: string | null;
  navError: TypedError | null;
  totalShares: string;
  paused: boolean;
  roles: string[];
  assets: string[];
  /** The policy only allows the base asset (no volatile asset can enter the vault). */
  stablecoinOnly: boolean;
  rules: RuleCount | null;
  /** Price-per-share return from the first to the last retained `NavSnapshot`, bps. */
  returnBps: number | null;
  worstDrawdownBps: number | null;
  /** First retained snapshot (RPC event retention is about 7 days on testnet). */
  since: number | null;
  snapshots: SnapshotPoint[];
}

export interface AgentsResponse {
  rows: AgentRow[];
  /** Sum of priced NAVs. */
  totalNav: string;
  asOf: string;
}

export interface PositionView {
  protocol: string;
  protocolName: string;
  kind: "idle" | "supply" | "collateral" | "debt" | "shares" | "liquidity";
  asset: string;
  assetSymbol: string;
  /** Raw units of `asset` (negative for a debt). */
  amount: string;
  assetDecimals: number;
  /** Base-asset units at strict oracle prices (negative for a debt). */
  value: string;
}

export interface ExposureView {
  protocol: string;
  protocolName: string;
  value: string;
  /** Share of the NAV in bps. */
  bps: number;
  capBps: number;
}

export interface CallView {
  target: string;
  targetName: string;
  fn: string;
  args: string[];
  maxLossBps: number;
  approve: boolean;
  /** Name of the SDK preset this rule matches, if any. */
  preset: string | null;
}

export interface RoleView {
  name: string;
  member: string;
  mode: "Normal" | "RiskOff";
  calls: CallView[];
  quota: { calls_per_hour: number; daily_cap_bps: number; daily_loss_bps: number; tx_cap_bps: number };
  /** Calls made in the current UTC hour and volume committed in the current UTC day. */
  usage: { callsThisHour: number; spentToday: string } | null;
  /** NAV lost over the rolling 24 h window by this role. */
  dailyLoss: string | null;
}

export interface PolicyView {
  limits: {
    calls_per_hour: number;
    daily_cap_bps: number;
    daily_loss_bps: number;
    max_drawdown_bps: number;
    max_exposure_bps: number;
    min_health_factor_bps: number;
    tx_cap_bps: number;
  };
  assets: { address: string; symbol: string }[];
  protocols: { address: string; name: string }[];
  exposureCaps: { protocol: string; name: string; bps: number }[];
  /** Loosening waiting for its public timelock (seconds since the epoch). */
  pendingEta: number | null;
}

export interface VaultDetail extends AgentRow {
  owner: string;
  session: string | null;
  /** Lowest health factor in bps; null when the vault has no debt. */
  healthFactorBps: string | null;
  positions: PositionView[];
  exposure: ExposureView[];
  policy: PolicyView | null;
  roleViews: RoleView[];
  /** Deposits and withdrawals can go through the Tsuna relayer for this vault. */
  sponsored: boolean;
  /** The server holds the member keys to run this vault's agent. */
  runnable: boolean;
  asOf: string;
}

export type Outcome = "authorized" | "blocked" | "simulated-only" | "rejected";

/** One action the agent proposed, or one vault call found on-chain. */
export interface TimelineAction {
  type: "action";
  id: string;
  at: string;
  source: "run" | "chain";
  runId: string | null;
  role: string;
  /** Human label: the runtime's action label, or the contract and function called. */
  label: string;
  proposed: boolean;
  simulation: { ok: boolean; error: TypedError | null } | null;
  outcome: Outcome;
  error: TypedError | null;
  /** Free-text reason for a runtime rejection (never reached the chain). */
  reason: string | null;
  hash: string | null;
  navBefore: string | null;
  navAfter: string | null;
}

/** A tool call or model message of an agent run that is not a vault call. */
export interface TimelineNote {
  type: "note";
  id: string;
  at: string;
  runId: string;
  tool: string | null;
  text: string;
  /** Raw tool output or error, shown under "Details". */
  detail: string | null;
  hash: string | null;
  failed: boolean;
}

export interface TimelineFlow {
  type: "deposit" | "withdraw";
  id: string;
  at: string;
  user: string;
  amount: string;
  shares: string;
  hash: string;
}

export interface TimelineRun {
  type: "run";
  id: string;
  at: string;
  runId: string;
  status: "running" | "finished" | "failed";
  role: string;
  model: string | null;
  error: string | null;
}

export type TimelineItem = TimelineAction | TimelineNote | TimelineFlow | TimelineRun;

export interface ActivityResponse {
  items: TimelineItem[];
  /** Where blocked attempts come from, for the honest footnote. */
  sources: { events: boolean; failedTxs: boolean; journal: boolean };
  asOf: string;
}

export interface HoldingView {
  vault: string;
  id: string;
  name: string;
  shares: string;
  /** Current value of the shares at the vault's price per share. */
  value: string;
  /** Deposited minus withdrawn amounts seen in retained events. */
  netDeposited: string;
  /** Oldest deposit or withdrawal event seen for this user, seconds since the epoch. */
  firstSeen: number | null;
  paused: boolean;
  pps: string | null;
}

export interface HoldingsResponse {
  user: string;
  holdings: HoldingView[];
  usdcBalance: string | null;
  asOf: string;
}

export interface AgentRunView {
  id: string;
  vault: string;
  status: "running" | "finished" | "failed";
  startedAt: string;
  finishedAt: string | null;
  role: string;
  model: string | null;
  error: string | null;
  items: TimelineItem[];
}
