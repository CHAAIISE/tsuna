/** `SpendingLimitError` codes of OpenZeppelin `stellar-accounts` 0.8.0. */
const SPENDING_LIMIT_ERRORS = {
  3220: "SmartAccountNotInstalled",
  3221: "SpendingLimitExceeded",
  3222: "InvalidLimitOrPeriod",
  3223: "NotAllowed",
  3224: "HistoryCapacityExceeded",
  3225: "AlreadyInstalled",
  3226: "LessThanZero",
  3227: "OnlyCallContractAllowed",
} as const;

export type PolicyRefusalName = (typeof SPENDING_LIMIT_ERRORS)[keyof typeof SPENDING_LIMIT_ERRORS];

export interface PolicyRefusal {
  name: PolicyRefusalName;
  code: number;
}

export function policyRefusalFromCodes(codes: Iterable<number>): PolicyRefusal | undefined {
  for (const code of codes) {
    const name = SPENDING_LIMIT_ERRORS[code as keyof typeof SPENDING_LIMIT_ERRORS];
    if (name) return { name, code };
  }
  return undefined;
}

/**
 * Maps a Soroban host error string (simulation error with its diagnostic log)
 * to the spending limit policy error that caused it, if any.
 */
export function policyRefusal(error: string): PolicyRefusal | undefined {
  return policyRefusalFromCodes([...error.matchAll(/Error\(Contract, #(\d+)\)/g)].map(match => Number(match[1])));
}
