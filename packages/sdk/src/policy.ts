import type { xdr } from "@stellar/stellar-sdk";
import { decode, decodeResult, encode, udt } from "./contracts/index.js";

/** How the vault checks one argument of an allowlisted call. */
export type ArgRule = "Any" | "Vault" | "Protocol" | "Amount" | "BlendRequests" | "Assets";
export type RoleMode = "Normal" | "RiskOff";

/** Contract `CallRule`: per-argument rules, the call's loss tolerance and whether the vault issues the approve. */
export interface CallRule {
  approve: boolean;
  args: ArgRule[];
  max_loss_bps: number;
}

/** One allowlisted `(target, fn)` pair with its rule. */
export interface PolicyCall {
  target: string;
  fn: string;
  rule: CallRule;
}

/** Contract `Limits` (basis points unless stated). */
export interface Limits {
  calls_per_hour: number;
  daily_cap_bps: number;
  daily_loss_bps: number;
  max_drawdown_bps: number;
  max_exposure_bps: number;
  min_health_factor_bps: number;
  tx_cap_bps: number;
}

/** Contract `Quota`: a role's own budgets. */
export interface Quota {
  calls_per_hour: number;
  daily_cap_bps: number;
  daily_loss_bps: number;
  tx_cap_bps: number;
}

export interface Role {
  member: string;
  mode: RoleMode;
  calls: PolicyCall[];
  quota: Quota;
}

/** Contract `PolicyV2`; contract maps are records keyed by address or role name. */
export interface Policy {
  /** Base asset first. */
  assets: string[];
  calls: PolicyCall[];
  /** Per-protocol exposure caps in bps; `null` keeps the vault-wide `max_exposure_bps`. */
  exposure_caps: Record<string, number> | null;
  /** Custody contracts whose balances count inside a protocol's perimeter. */
  guards: Record<string, string[]>;
  limits: Limits;
  protocols: string[];
  /** Named roles besides `default`; `null` for a policy without roles. */
  roles: Record<string, Role> | null;
}

export interface PendingPolicy {
  eta: bigint;
  policy: Policy;
}

/** Contract defaults of `Limits` (as used by the demo vaults). */
export const DEFAULT_LIMITS: Limits = {
  calls_per_hour: 60,
  daily_cap_bps: 100_000,
  daily_loss_bps: 50,
  max_drawdown_bps: 2_000,
  max_exposure_bps: 5_000,
  min_health_factor_bps: 13_000,
  tx_cap_bps: 10_000,
};

type Tagged = { tag: string };
type NativeCalls = [[string, string], NativeRule][];
interface NativeRule { approve: boolean; args: Tagged[]; max_loss_bps: number }
interface NativeRole { calls: NativeCalls; member: string; mode: Tagged; quota: Quota }
interface NativePolicy {
  assets: string[];
  calls: NativeCalls;
  exposure_caps: [string, number][] | null;
  guards: [string, string[]][];
  limits: Limits;
  protocols: string[];
  roles: [string, NativeRole][] | null;
}

const toNativeCalls = (calls: PolicyCall[]): NativeCalls =>
  calls.map(({ target, fn, rule }) => [[target, fn], { ...rule, args: rule.args.map(tag => ({ tag })) }]);

const fromNativeCalls = (calls: NativeCalls): PolicyCall[] =>
  calls.map(([[target, fn], rule]) => ({
    target, fn, rule: { approve: rule.approve, args: rule.args.map(arg => arg.tag as ArgRule), max_loss_bps: rule.max_loss_bps },
  }));

function toNativeRole(role: Role): NativeRole {
  return { calls: toNativeCalls(role.calls), member: role.member, mode: { tag: role.mode }, quota: role.quota };
}

function fromNativeRole(role: NativeRole): Role {
  return { member: role.member, mode: role.mode.tag as RoleMode, calls: fromNativeCalls(role.calls), quota: role.quota };
}

/** `PolicyV2` ScVal for `register` / `propose_policy`. */
export function encodePolicy(policy: Policy): xdr.ScVal {
  const native: NativePolicy = {
    assets: policy.assets,
    calls: toNativeCalls(policy.calls),
    exposure_caps: policy.exposure_caps && Object.entries(policy.exposure_caps),
    guards: Object.entries(policy.guards),
    limits: policy.limits,
    protocols: policy.protocols,
    roles: policy.roles && Object.entries(policy.roles).map(([name, role]) => [name, toNativeRole(role)]),
  };
  return encode("policyRegistry", native, udt("PolicyV2"));
}

export function decodePolicy(value: xdr.ScVal): Policy {
  return fromNativePolicy(decode<NativePolicy>("policyRegistry", value, udt("PolicyV2")));
}

function fromNativePolicy(native: NativePolicy): Policy {
  return {
    assets: native.assets,
    calls: fromNativeCalls(native.calls),
    exposure_caps: native.exposure_caps && Object.fromEntries(native.exposure_caps),
    guards: Object.fromEntries(native.guards),
    limits: native.limits,
    protocols: native.protocols,
    roles: native.roles && Object.fromEntries(native.roles.map(([name, role]) => [name, fromNativeRole(role)])),
  };
}

export function encodeRole(role: Role): xdr.ScVal {
  return encode("policyRegistry", toNativeRole(role), udt("Role"));
}

/** Return value of the registry's `pending_policy`. */
export function decodePending(value: xdr.ScVal): PendingPolicy | null {
  const native = decodeResult<{ eta: bigint; policy: NativePolicy } | null>("policyRegistry", "pending_policy", value);
  return native && { eta: native.eta, policy: fromNativePolicy(native.policy) };
}

/** The rule allowlisting `(target, fn)` for `role` (`default` reads the policy's own calls). */
export function ruleFor(policy: Policy, target: string, fn: string, role = "default"): CallRule | undefined {
  const calls = role === "default" ? policy.calls : policy.roles?.[role]?.calls ?? [];
  return calls.find(call => call.target === target && call.fn === fn)?.rule;
}
