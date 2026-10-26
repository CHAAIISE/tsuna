import { describe, expect, test } from "vitest";
import { spec, type ContractName } from "./contracts/index.js";
import {
  FACTORY_ERRORS, TsunaRefusal, ORACLE_ERRORS, REGISTRY_ERRORS, SIGNAL_BUDGET_ERRORS, VAULT_ERRORS,
  describeError, isTsunaError, parseHostError, parseHostFailure,
} from "./errors.js";

const tables: [ContractName, Record<number, [string, string]>][] = [
  ["agentVault", VAULT_ERRORS],
  ["policyRegistry", REGISTRY_ERRORS],
  ["oracleRouter", ORACLE_ERRORS],
  ["vaultFactory", FACTORY_ERRORS],
  ["signalBudget", SIGNAL_BUDGET_ERRORS],
];

/** Simulation error of a `USDC.transfer` sent through `execute`, as returned by testnet RPC. */
const SIMULATION_ERROR = `HostError: Error(Contract, #1)

Event log (newest first):
   0: [Diagnostic Event] contract:CCBRIR3I772JUQ5ZPD7FJ4WAILTKZL2BPGPBL5ZSA46O5TEHJHZK3YEL, topics:[error, Error(Contract, #1)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"
   1: [Diagnostic Event] contract:CBU24MQCWQJZPQIKGVWKWXZT26UIDVJJ5ZE2PZNNRFYGS6DRHNO7R2YU, topics:[fn_return, policy], data:{}
   2: [Diagnostic Event] topics:[fn_call, CCBRIR3I772JUQ5ZPD7FJ4WAILTKZL2BPGPBL5ZSA46O5TEHJHZK3YEL, execute], data:[]`;

describe("error table", () => {
  test.each(tables)("%s: every contract error code has a name and a sentence", (contract, table) => {
    const cases = spec(contract).errorCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      const row = table[entry.value];
      expect(row?.[0], `${contract} #${entry.value}`).toBe(entry.name.toString());
      expect(row?.[1]).toMatch(/^[A-Z].*\.$/);
    }
  });

  test("names vault refusals of the attack scenarios", () => {
    expect(describeError("vault", 1)).toEqual({
      contract: "vault", code: 1, name: "CallNotAllowed", message: "The vault policy does not allowlist this contract function.",
    });
    expect(describeError("vault", 2).name).toBe("DestinationNotVault");
    expect(describeError("vault", 5).name).toBe("NavDropped");
    expect(describeError("vault", 19).name).toBe("AssetNotAllowed");
    expect(describeError("vault", 17).name).toBe("HealthFactorTooLow");
    expect(describeError("vault", 36).name).toBe("RiskIncreased");
    expect(describeError("registry", 6).name).toBe("TimelockActive");
    expect(describeError("oracle", 4).name).toBe("PriceJump");
  });

  test("attributes OpenZeppelin spending-limit codes to the signal budget", () => {
    expect(describeError("other", 3221)).toMatchObject({ contract: "signal_budget", name: "SpendingLimitExceeded" });
  });

  test("keeps unknown external codes generic", () => {
    expect(describeError("other", 1203)).toMatchObject({ contract: "other", code: 1203, name: "Error #1203" });
  });
});

describe("host error parsing", () => {
  test("finds the contract where the failure started", () => {
    expect(parseHostError(SIMULATION_ERROR)).toEqual({ contractId: "CCBRIR3I772JUQ5ZPD7FJ4WAILTKZL2BPGPBL5ZSA46O5TEHJHZK3YEL", code: 1 });
  });

  test("reads a bare contract error", () => {
    expect(parseHostError("HostError: Error(Contract, #28)")).toEqual({ code: 28 });
    expect(parseHostError("no contract error here")).toBeNull();
  });

  test("names host authorization failures", () => {
    expect(parseHostFailure("HostError: Error(Auth, InvalidAction)")).toMatchObject({ contract: "other", name: "AuthFailed" });
    expect(parseHostFailure("HostError: Error(Contract, #1)")).toBeNull();
  });

  test("refusals carry a typed error", () => {
    const refusal = new TsunaRefusal(describeError("vault", 1));
    expect(refusal.message).toBe("CallNotAllowed (vault #1): The vault policy does not allowlist this contract function.");
    expect(isTsunaError(refusal.error)).toBe(true);
    expect(isTsunaError({ code: 1 })).toBe(false);
  });
});
