import { Address, xdr } from "@stellar/stellar-sdk";

export type ErrorSource = "vault" | "registry" | "oracle" | "factory" | "signal_budget" | "other";

/** A contract error code, named and explained. */
export interface TsunaError {
  contract: ErrorSource;
  code: number;
  name: string;
  message: string;
}

type Table = Record<number, [name: string, message: string]>;

/** `agent_vault` `Error` (contracts/agent_vault/src/errors.rs). */
export const VAULT_ERRORS: Table = {
  1: ["CallNotAllowed", "The vault policy does not allowlist this contract function."],
  2: ["DestinationNotVault", "An argument that must name the vault itself names another address."],
  3: ["SpenderNotProtocol", "An argument that must name an allowlisted protocol names another address."],
  4: ["ArgCountMismatch", "The call has a different number of arguments than its rule."],
  5: ["NavDropped", "The vault's net asset value fell by more than the call's loss tolerance."],
  6: ["Paused", "The vault is paused: only withdrawals and risk-off roles may act."],
  7: ["BadAdapterData", "A protocol returned data the vault cannot value safely."],
  8: ["InvalidAmount", "The amount is zero, negative or unreadable."],
  9: ["InsufficientShares", "The holder owns fewer shares than requested."],
  10: ["ZeroShares", "The deposit is too small to mint a single share."],
  11: ["ArithmeticOverflow", "An amount overflowed the vault's arithmetic."],
  12: ["Insolvent", "The vault's debts exceed its assets."],
  14: ["TxCapExceeded", "The call commits more of the NAV than the per-transaction cap allows."],
  15: ["DailyCapExceeded", "The call would exceed the daily volume cap."],
  16: ["RateLimited", "The agent has used all of its calls for this hour."],
  17: ["HealthFactorTooLow", "The lending health factor would fall below the policy floor."],
  18: ["SessionRevoked", "The creator revoked the agent's session key."],
  19: ["AssetNotAllowed", "The call routes an asset outside the vault's asset list."],
  20: ["DailyLossExceeded", "Losses over the last 24 hours would exceed the daily loss budget."],
  21: ["AllowanceNotCleared", "The call left a token allowance open to a protocol."],
  22: ["ValueLeftPerimeter", "Token balances left the vault and its declared protocol custody contracts."],
  23: ["ExposureCapExceeded", "The call raises a protocol's share of the NAV above its cap."],
  24: ["StalePrice", "The oracle price is too old to trust."],
  25: ["SourcesDisagree", "The oracle's two price sources disagree beyond the allowed deviation."],
  26: ["PriceJump", "The oracle price jumped too far, too fast, to be trusted yet."],
  27: ["OracleUnavailable", "The oracle cannot price an asset the call depends on."],
  28: ["PolicyMissing", "The creator has not registered this vault's policy yet."],
  29: ["ProtocolNotAllowed", "The protocol is not allowlisted in the vault policy."],
  30: ["AdapterInUse", "The protocol already has an adapter or still holds value for the vault."],
  31: ["TooManyPositions", "The vault already values the maximum number of protocol positions."],
  32: ["SlippageTooLoose", "The swap's minimum output is below the oracle quote less the loss tolerance."],
  33: ["RepaymentUnavailable", "The vault holds too little of the debt asset to repay the leaver's share."],
  34: ["RoleNotFound", "The policy in force defines no role with this name."],
  35: ["NotRoleMember", "The signer is not the member of this role."],
  36: ["RiskIncreased", "A risk-off call left the vault riskier or poorer than before."],
  37: ["ProtocolChanged", "The protocol's code changed since the vault pinned it; the owner must review and acknowledge it."],
};

/** `policy_registry` `Error`. */
export const REGISTRY_ERRORS: Table = {
  1: ["NotRegistered", "This vault has no policy in the registry."],
  2: ["AlreadyRegistered", "This vault already has a policy; changes go through propose_policy."],
  3: ["InvalidPolicy", "The policy breaks a registry bound (limits, list sizes, roles or base asset)."],
  4: ["VaultHasDeposits", "An initial policy cannot be installed once the vault holds deposits."],
  5: ["NoPendingPolicy", "There is no pending policy change to apply."],
  6: ["TimelockActive", "The pending loosening is still inside its public timelock."],
  7: ["RoleNotFound", "The policy defines no role with this name."],
};

/** `oracle_router` `Error`. */
export const ORACLE_ERRORS: Table = {
  1: ["NoPriceFeed", "The oracle router has no feed configured for this asset."],
  2: ["StalePrice", "The source price is older than the router accepts."],
  3: ["SourcesDisagree", "Reflector and Chainlink disagree beyond the allowed deviation."],
  4: ["PriceJump", "The price moved more than the jump breaker allows within 15 minutes."],
  5: ["InvalidConfig", "The oracle configuration is out of bounds."],
  6: ["BadSourceData", "A price source returned unusable data."],
  7: ["DemoDisabled", "Forced demo prices are disabled on this router."],
};

/** `vault_factory` `Error`. */
export const FACTORY_ERRORS: Table = {
  1: ["RefAlreadySet", "The executable tag is already published; upgrades go through propose_ref."],
  2: ["RefNotSet", "No vault executable is published under this tag yet."],
  3: ["TimelockActive", "The fleet upgrade is still inside its timelock."],
  4: ["NoPendingRef", "There is no pending fleet upgrade to apply."],
  5: ["SameRef", "The proposed executable is already in use."],
  6: ["DistinctAdminsRequired", "The factory needs two distinct admins."],
};

/** OpenZeppelin smart account and `spending_limit` policy errors of the signal budget. */
export const SIGNAL_BUDGET_ERRORS: Table = {
  3000: ["ContextRuleNotFound", "The smart account has no context rule with this id."],
  3002: ["UnvalidatedContext", "No context rule of the smart account authorizes this call."],
  3003: ["ExternalVerificationFailed", "The signer's signature did not verify."],
  3004: ["NoSignersAndPolicies", "A context rule needs at least one signer or policy."],
  3005: ["PastValidUntil", "The context rule has expired."],
  3006: ["SignerNotFound", "The signer is not part of the context rule."],
  3007: ["DuplicateSigner", "The signer is already part of the context rule."],
  3008: ["PolicyNotFound", "The policy is not part of the context rule."],
  3009: ["DuplicatePolicy", "The policy is already part of the context rule."],
  3010: ["TooManySigners", "The context rule has too many signers."],
  3011: ["TooManyPolicies", "The context rule has too many policies."],
  3012: ["MathOverflow", "A smart account computation overflowed."],
  3013: ["KeyDataTooLarge", "The signer key data is too large."],
  3014: ["ContextRuleIdsLengthMismatch", "The signature selects a different number of context rules than calls."],
  3015: ["NameTooLong", "The context rule name is too long."],
  3016: ["UnauthorizedSigner", "The signer is not authorized for this context."],
  3017: ["DelegatedSignerIsContextContract", "A delegated signer cannot be the contract being called."],
  3018: ["SelfDelegatedSigner", "The smart account cannot delegate to itself."],
  3220: ["SmartAccountNotInstalled", "The smart account has no spending limit policy installed."],
  3221: ["SpendingLimitExceeded", "The payment exceeds the agent's spending limit for this period."],
  3222: ["InvalidLimitOrPeriod", "The spending limit or its period is invalid."],
  3223: ["NotAllowed", "The spending limit policy does not allow this transaction."],
  3224: ["HistoryCapacityExceeded", "The spending history is full."],
  3225: ["AlreadyInstalled", "The spending limit policy is already installed for this rule."],
  3226: ["LessThanZero", "The transfer amount is negative."],
  3227: ["OnlyCallContractAllowed", "The spending limit only applies to contract-call contexts."],
};

const TABLES: Record<Exclude<ErrorSource, "other">, Table> = {
  vault: VAULT_ERRORS,
  registry: REGISTRY_ERRORS,
  oracle: ORACLE_ERRORS,
  factory: FACTORY_ERRORS,
  signal_budget: SIGNAL_BUDGET_ERRORS,
};

/** Names and explains `code` raised by a contract of kind `contract`. */
export function describeError(contract: ErrorSource, code: number): TsunaError {
  // OZ spending-limit and smart-account codes are unique, whichever contract raised them.
  const source = contract === "other" && SIGNAL_BUDGET_ERRORS[code] ? "signal_budget" : contract;
  const entry = source === "other" ? undefined : TABLES[source][code];
  if (!entry) {
    return { contract: source, code, name: `Error #${code}`, message: `Contract error #${code} of an external contract.` };
  }
  return { contract: source, code, name: entry[0], message: entry[1] };
}

const SOURCES: readonly string[] = ["vault", "registry", "oracle", "factory", "signal_budget", "other"];

export function isTsunaError(value: unknown): value is TsunaError {
  return typeof value === "object" && value !== null
    && "contract" in value && typeof value.contract === "string" && SOURCES.includes(value.contract)
    && "code" in value && typeof value.code === "number"
    && "name" in value && typeof value.name === "string"
    && "message" in value && typeof value.message === "string";
}

/** Thrown when a contract refuses a call during simulation (no transaction was sent). */
export class TsunaRefusal extends Error {
  constructor(readonly error: TsunaError, readonly detail?: string) {
    super(`${error.name} (${error.contract} #${error.code}): ${error.message}`);
    this.name = "TsunaRefusal";
  }
}

/** Raw contract error found in a host error text or in diagnostic events. */
export interface RawContractError {
  /** Contract that raised the error first, when the source names it. */
  contractId?: string;
  code: number;
}

const HOST_ERROR = /Error\(Contract, #(\d+)\)/;
const EVENT_LINE = /contract:(C[A-Z2-7]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/g;

/**
 * Contract error of a simulation error text. The host event log lists events newest first;
 * the originating contract is the oldest `error` event with a contract code.
 */
export function parseHostError(text: string): RawContractError | null {
  const events = [...text.matchAll(EVENT_LINE)];
  const origin = events.at(-1);
  if (origin) return { contractId: origin[1] as string, code: Number(origin[2]) };
  const match = HOST_ERROR.exec(text);
  return match ? { code: Number(match[1]) } : null;
}

/**
 * Contract error recorded in a transaction's diagnostic events: the first `error` event
 * carrying a contract code, which is the contract where the failure started.
 */
export function errorFromEvents(events: xdr.DiagnosticEvent[]): RawContractError | null {
  for (const error of errorEvents(events)) {
    if (error.value.type !== "sceContract") continue;
    return { ...(error.contractId ? { contractId: error.contractId } : {}), code: Number(error.value.contractCode) };
  }
  return null;
}

function* errorEvents(events: xdr.DiagnosticEvent[]): Generator<{ contractId?: string; value: xdr.ScError }> {
  for (const { event } of events) {
    const topics = event.body.v0.topics;
    if (topics[0]?.type !== "scvSymbol" || String(topics[0].value) !== "error") continue;
    const error = topics.find(topic => topic.type === "scvError");
    if (!error || error.type !== "scvError") continue;
    const contractId = event.contractId
      ? Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(event.contractId)).toString()
      : undefined;
    yield { ...(contractId ? { contractId } : {}), value: error.value };
  }
}

const HOST_MESSAGES: Record<string, string> = {
  Auth: "An authorization was missing or its signature did not verify.",
  Budget: "The transaction ran out of its CPU or memory budget.",
  Storage: "The transaction touched ledger state outside its footprint, or missing state.",
};

/** Host (non-contract) failure, e.g. `Error(Auth, InvalidAction)`, named `AuthFailed`-style. */
export function hostError(kind: string, code: string): TsunaError {
  return {
    contract: "other",
    code: 0,
    name: kind === "Auth" ? "AuthFailed" : `Host${kind}Error`,
    message: HOST_MESSAGES[kind] ?? `The Soroban host failed with ${kind}/${code}.`,
  };
}

/** First host failure in diagnostic events, when no contract error explains the failure. */
export function hostErrorFromEvents(events: xdr.DiagnosticEvent[]): TsunaError | null {
  for (const { value } of errorEvents(events)) {
    if (value.type === "sceContract") continue;
    const kind = value.type.slice(3);
    return hostError(kind, "code" in value ? String(value.code.name) : "unknown");
  }
  return null;
}

const HOST_TEXT = /Error\((\w+), (\w+)\)/;

/** Host failure named in a simulation error text, e.g. `Error(Auth, InvalidAction)`. */
export function parseHostFailure(text: string): TsunaError | null {
  const match = HOST_TEXT.exec(text);
  return match && match[1] !== "Contract" ? hostError(match[1] as string, match[2] as string) : null;
}
