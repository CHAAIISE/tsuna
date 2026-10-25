/**
 * Safe-by-default rules per protocol action, composed into a vault policy instead of raw rules.
 *
 * Loss tolerance per call: 10 bps between stablecoins, 50 bps when a volatile asset is
 * involved. Each preset also declares the protocol's custody contracts (guards) whose balances
 * count inside the vault's perimeter.
 *
 * Blend routes every action through one entry point, `submit_with_allowance`, and the vault
 * checks its requests (assets in the vault's list, value within the caps), not their type:
 * `blend.supply`, `blend.withdraw`, `blend.borrow` and `blend.repay` therefore grant the same
 * `(pool, submit_with_allowance)` rule. What a borrow may do is bounded by the health-factor
 * floor, the exposure caps and the NAV checks on the outcome.
 */
import { DEFAULT_LIMITS, type ArgRule, type Limits, type Policy, type PolicyCall, type Quota, type Role } from "./policy.js";
import { TESTNET } from "./network.js";

export type Protocol = "blend" | "defindex" | "soroswap" | "aquarius";

/** Per-call loss tolerance, in bps. */
export const MAX_LOSS_BPS = { stable: 10, volatile: 50 } as const;

/** Contracts a preset applies to. */
export interface Venues {
  blendPool?: string;
  defindexVault?: string;
  /** Contracts holding a DeFindex vault's funds (its strategy, the pool it lends to). */
  defindexCustody?: string[];
  soroswapRouter?: string;
  /** Soroswap pairs the router may route through. */
  soroswapPairs?: string[];
  aquariusPool?: string;
}

export interface PresetOptions {
  /** A volatile asset is involved: 50 bps loss tolerance instead of 10. */
  volatile?: boolean;
}

/** What a preset adds to a policy. */
export interface Grant {
  calls: PolicyCall[];
  protocols: string[];
  guards: Record<string, string[]>;
}

export interface CallPreset {
  kind: "call";
  id: string;
  label: string;
  protocol: Protocol;
  description: string;
  fn: string;
  args: ArgRule[];
  /** The vault approves the target for the call's exact inflow and checks it is consumed. */
  approve: boolean;
  /** Default tolerance class when `volatile` is not given. */
  volatile: boolean;
  grant(venues: Venues, options?: PresetOptions): Grant;
}

export interface RolePreset {
  kind: "role";
  id: string;
  label: string;
  description: string;
  quota: Quota;
  /** Calls the role may make (each checked on the outcome in RiskOff mode). */
  presets: CallPreset[];
  role(venues: Venues, member: string, options?: PresetOptions): Role;
}

export type Preset = CallPreset | RolePreset;

function need(value: string | undefined, name: keyof Venues): string {
  if (!value) throw new Error(`Preset needs venues.${name}`);
  return value;
}

function callPreset(spec: Omit<CallPreset, "kind" | "grant"> & {
  target: (venues: Venues) => string;
  custody?: (venues: Venues) => string[];
}): CallPreset {
  const { target, custody, ...rest } = spec;
  return {
    kind: "call",
    ...rest,
    grant(venues, options = {}) {
      const address = target(venues);
      const guards = custody?.(venues) ?? [];
      const maxLoss = (options.volatile ?? spec.volatile) ? MAX_LOSS_BPS.volatile : MAX_LOSS_BPS.stable;
      return {
        calls: [{ target: address, fn: spec.fn, rule: { approve: spec.approve, args: [...spec.args], max_loss_bps: maxLoss } }],
        protocols: [address],
        guards: guards.length > 0 ? { [address]: guards } : {},
      };
    },
  };
}

const blendPool = (venues: Venues) => need(venues.blendPool, "blendPool");
const BLEND_ARGS: ArgRule[] = ["Vault", "Vault", "Vault", "BlendRequests"];

function blendPreset(id: string, label: string, description: string, volatile: boolean): CallPreset {
  return callPreset({
    id, label, protocol: "blend", description, fn: "submit_with_allowance",
    args: BLEND_ARGS, approve: true, volatile, target: blendPool,
  });
}

const defindex = (venues: Venues) => need(venues.defindexVault, "defindexVault");
const defindexCustody = (venues: Venues) => venues.defindexCustody ?? [];
const aquarius = (venues: Venues) => need(venues.aquariusPool, "aquariusPool");

const blendSupply = blendPreset("blend.supply", "Blend supply",
  "Lend an allowed asset to the Blend pool; funds and the receipt stay with the vault.", false);
const blendWithdraw = blendPreset("blend.withdraw", "Blend withdraw",
  "Withdraw supplied assets from Blend back to the vault.", false);
const blendBorrow = blendPreset("blend.borrow", "Blend borrow",
  "Borrow an allowed asset against the vault's collateral, above the health-factor floor.", true);
const blendRepay = blendPreset("blend.repay", "Blend repay",
  "Repay the vault's Blend debt from its own balance.", true);
const defindexDeposit = callPreset({
  id: "defindex.deposit", label: "DeFindex deposit", protocol: "defindex",
  description: "Deposit into a DeFindex vault; the vault authorizes the exact transfer and receives the shares.",
  fn: "deposit", args: ["Any", "Any", "Vault", "Any"], approve: false, volatile: false,
  target: defindex, custody: defindexCustody,
});
const defindexWithdraw = callPreset({
  id: "defindex.withdraw", label: "DeFindex withdraw", protocol: "defindex",
  description: "Redeem DeFindex shares back to the vault; shares cannot be transferred.",
  fn: "withdraw", args: ["Any", "Any", "Vault"], approve: false, volatile: false,
  target: defindex, custody: defindexCustody,
});
const soroswapSwap = callPreset({
  id: "soroswap.swap", label: "Soroswap swap", protocol: "soroswap",
  description: "Swap on Soroswap along a route of allowed assets only, output to the vault, minimum output at the oracle quote.",
  fn: "swap_exact_tokens_for_tokens", args: ["Any", "Any", "Assets", "Vault", "Any"], approve: false, volatile: true,
  target: venues => venues.soroswapRouter ?? TESTNET.soroswapRouter,
  custody: venues => venues.soroswapPairs ?? [],
});
const aquariusDeposit = callPreset({
  id: "aquarius.deposit", label: "Aquarius deposit", protocol: "aquarius",
  description: "Add liquidity to an Aquarius pool; LP shares go to the vault and are valued at oracle prices.",
  fn: "deposit", args: ["Vault", "Any", "Any"], approve: false, volatile: true, target: aquarius,
});
const aquariusWithdraw = callPreset({
  id: "aquarius.withdraw", label: "Aquarius withdraw", protocol: "aquarius",
  description: "Remove liquidity from an Aquarius pool back to the vault.",
  fn: "withdraw", args: ["Vault", "Any", "Any"], approve: false, volatile: true, target: aquarius,
});

/** Tight budgets of the risk-off role: small, rare calls that may only unwind. */
export const RISK_OFF_QUOTA: Quota = { calls_per_hour: 6, daily_cap_bps: 10_000, daily_loss_bps: 50, tx_cap_bps: 2_500 };

const riskOff: RolePreset = {
  kind: "role",
  id: "riskOff",
  label: "Risk-off agent",
  description: "Acts even while the vault is paused, but every call must leave the vault no riskier: "
    + "health factor not lower, no protocol exposure higher, no new position or asset, NAV kept within tolerance.",
  quota: RISK_OFF_QUOTA,
  presets: [blendWithdraw, blendRepay, defindexWithdraw],
  role(venues, member, options = { volatile: true }) {
    const calls = merge(this.presets
      .filter(preset => preset.protocol !== "defindex" || venues.defindexVault)
      .map(preset => preset.grant(venues, options))).calls;
    return { member, mode: "RiskOff", calls, quota: { ...RISK_OFF_QUOTA } };
  },
};

export const presets = {
  "blend.supply": blendSupply,
  "blend.withdraw": blendWithdraw,
  "blend.borrow": blendBorrow,
  "blend.repay": blendRepay,
  "defindex.deposit": defindexDeposit,
  "defindex.withdraw": defindexWithdraw,
  "soroswap.swap": soroswapSwap,
  "aquarius.deposit": aquariusDeposit,
  "aquarius.withdraw": aquariusWithdraw,
  riskOff,
} satisfies Record<string, Preset>;

export type PresetId = keyof typeof presets;
export type CallPresetId = Exclude<PresetId, "riskOff">;

/**
 * Merges grants; two grants of the same `(target, fn)` keep the loosest tolerance and approve
 * flag, so every selected action stays possible.
 */
export function merge(grants: Grant[]): Grant {
  const calls = new Map<string, PolicyCall>();
  const protocols = new Set<string>();
  const guards: Record<string, string[]> = {};
  for (const grant of grants) {
    for (const call of grant.calls) {
      const key = `${call.target}:${call.fn}`;
      const known = calls.get(key);
      if (known && known.rule.args.join() !== call.rule.args.join()) {
        throw new Error(`Conflicting argument rules for ${call.fn} on ${call.target}`);
      }
      calls.set(key, known ? {
        ...known,
        rule: {
          ...known.rule,
          approve: known.rule.approve || call.rule.approve,
          max_loss_bps: Math.max(known.rule.max_loss_bps, call.rule.max_loss_bps),
        },
      } : { ...call, rule: { ...call.rule, args: [...call.rule.args] } });
    }
    for (const protocol of grant.protocols) protocols.add(protocol);
    for (const [protocol, custody] of Object.entries(grant.guards)) {
      guards[protocol] = [...new Set([...(guards[protocol] ?? []), ...custody])];
    }
  }
  return { calls: [...calls.values()], protocols: [...protocols], guards };
}

export interface PolicySpec {
  /** Vault assets, base asset first. */
  assets: string[];
  venues: Venues;
  actions: (CallPresetId | { preset: CallPresetId; volatile: boolean })[];
  limits?: Partial<Limits>;
  exposureCaps?: Record<string, number>;
  /** Member key of a risk-off role named `riskoff`. */
  riskOffMember?: string;
}

/** Name of the role {@link composePolicy} creates from the `riskOff` preset. */
export const RISK_OFF_ROLE = "riskoff";

/** A complete vault policy from presets. */
export function composePolicy(spec: PolicySpec): Policy {
  const grant = merge(spec.actions.map(action => typeof action === "string"
    ? presets[action].grant(spec.venues)
    : presets[action.preset].grant(spec.venues, { volatile: action.volatile })));
  return {
    assets: [...spec.assets],
    calls: grant.calls,
    exposure_caps: spec.exposureCaps ? { ...spec.exposureCaps } : null,
    guards: grant.guards,
    limits: { ...DEFAULT_LIMITS, ...spec.limits },
    protocols: grant.protocols,
    roles: spec.riskOffMember ? { [RISK_OFF_ROLE]: riskOff.role(spec.venues, spec.riskOffMember) } : null,
  };
}

/**
 * Which preset produced `call`, for display: the first preset whose function and argument
 * rules match (Blend actions share one rule and are reported as `blend.supply`).
 */
export function presetOf(call: PolicyCall): CallPreset | undefined {
  return Object.values(presets).find((preset): preset is CallPreset =>
    preset.kind === "call" && preset.fn === call.fn && preset.args.join() === call.rule.args.join());
}
