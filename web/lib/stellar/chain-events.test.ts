import { Account, Address, Contract, Keypair, Networks, StrKey, TransactionBuilder, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeVaultCall, decodeVaultEvent, failureFromDiagnostics } from "./chain-events";

const VAULT = "CCRLI4LNEJQGLHVPX56OEIMQ7FVLRD6MLOAKFJHHWS7VD3JUNKV6Z3NF";
const BLEND = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const USER = "CAEBOFFWPGPJEHG5427IWYFCUPW6UPW25SJR45E6777NZUA5Y4VPLX3S";
const symbol = (value: string) => nativeToScVal(value, { type: "symbol" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

function event(topic: xdr.ScVal[], value: xdr.ScVal): rpc.Api.EventResponse {
  return {
    id: "1", type: "contract", ledger: 42, ledgerClosedAt: "2026-10-25T21:00:00Z", transactionIndex: 1, operationIndex: 0,
    inSuccessfulContractCall: true, txHash: "ab".repeat(32), contractId: new Contract(VAULT), topic, value,
  };
}

const map = (entries: Record<string, xdr.ScVal>) => xdr.ScVal.scvMap(Object.entries(entries).map(([key, val]) => new xdr.ScMapEntry({ key: symbol(key), val })));

describe("vault events", () => {
  it("decodes a default-role execution with its NAV before and after", () => {
    const decoded = decodeVaultEvent(event(
      [symbol("executed"), new Address(BLEND).toScVal(), symbol("submit_with_allowance")],
      map({ nav_after: i128(1_999n), nav_before: i128(2_000n) }),
    ));
    expect(decoded).toMatchObject({ kind: "executed", vault: VAULT, role: "default", target: BLEND, fn: "submit_with_allowance", navBefore: "2000", navAfter: "1999" });
  });

  it("decodes a role execution and a deposit", () => {
    expect(decodeVaultEvent(event(
      [symbol("role_executed"), symbol("riskoff"), new Address(BLEND).toScVal(), symbol("submit_with_allowance")],
      map({ nav_after: i128(1n), nav_before: i128(1n) }),
    ))).toMatchObject({ kind: "executed", role: "riskoff", target: BLEND });
    expect(decodeVaultEvent(event(
      [symbol("deposited"), new Address(USER).toScVal()],
      map({ amount: i128(10_000_000_000n), shares: i128(10n ** 20n) }),
    ))).toMatchObject({ kind: "deposited", user: USER, amount: "10000000000", shares: "100000000000000000000" });
  });

  it("ignores other vault events", () => {
    expect(decodeVaultEvent(event([symbol("nav_snapshot")], map({ nav: i128(1n) })))).toBeNull();
  });
});

describe("vault calls in envelopes", () => {
  const source = Keypair.random();
  const envelope = (operation: xdr.Operation) => new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100", networkPassphrase: Networks.TESTNET,
  }).addOperation(operation).setTimeout(30).build().toXDR();

  it("reads the target and function of execute and execute_as", () => {
    const vault = new Contract(VAULT);
    expect(decodeVaultCall(envelope(vault.call("execute", new Address(BLEND).toScVal(), symbol("submit"), xdr.ScVal.scvVec([]))), Networks.TESTNET))
      .toEqual({ vault: VAULT, role: "default", target: BLEND, fn: "submit" });
    expect(decodeVaultCall(envelope(vault.call("execute_as", new Address(source.publicKey()).toScVal(), symbol("riskoff"), new Address(BLEND).toScVal(), symbol("submit"), xdr.ScVal.scvVec([]))), Networks.TESTNET))
      .toEqual({ vault: VAULT, role: "riskoff", target: BLEND, fn: "submit" });
  });

  it("skips other calls", () => {
    expect(decodeVaultCall(envelope(new Contract(VAULT).call("deposit", new Address(USER).toScVal(), i128(1n))), Networks.TESTNET)).toBeNull();
    expect(decodeVaultCall("not xdr", Networks.TESTNET)).toBeNull();
  });
});

describe("diagnostic failures", () => {
  const diagnostic = (contract: string | null, error: xdr.ScError) => new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: contract ? xdr.ContractId.fromXdrObject(StrKey.decodeContract(contract)) : null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [symbol("error"), xdr.ScVal.scvError(error)], data: xdr.ScVal.scvVoid() })),
    }),
  });

  it("returns the first contract error, where the failure started", () => {
    const events = [diagnostic(VAULT, xdr.ScError.sceContract(17)), diagnostic(BLEND, xdr.ScError.sceContract(5))];
    expect(failureFromDiagnostics(events)).toEqual({ kind: "contract", contractId: VAULT, code: 17 });
  });

  it("falls back to a host error", () => {
    expect(failureFromDiagnostics([diagnostic(null, xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction))])).toEqual({ kind: "host", type: "Auth" });
    expect(failureFromDiagnostics([])).toBeNull();
  });
});
