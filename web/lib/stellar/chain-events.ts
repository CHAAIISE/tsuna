import {
  Address, FeeBumpTransaction, TransactionBuilder, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";

/** A vault event the activity feed shows. Amounts are base units as decimal strings. */
export type VaultEvent =
  | {
    kind: "executed";
    vault: string;
    role: string;
    target: string;
    fn: string;
    navBefore: string;
    navAfter: string;
    hash: string;
    at: string;
    ledger: number;
  }
  | {
    kind: "deposited" | "withdrawn";
    vault: string;
    user: string;
    amount: string;
    shares: string;
    hash: string;
    at: string;
    ledger: number;
  };

const symbolOf = (value: xdr.ScVal | undefined) => value?.type === "scvSymbol" ? String(value.value) : null;
const addressOf = (value: xdr.ScVal | undefined) => value ? Address.fromScVal(value).toString() : "";
const text = (value: unknown) => typeof value === "bigint" ? value.toString() : String(value ?? "0");

/** Decodes `executed`, `role_executed`, `deposited` and `withdrawn` events of `agent_vault`. */
export function decodeVaultEvent(event: rpc.Api.EventResponse): VaultEvent | null {
  const name = symbolOf(event.topic[0]);
  const vault = event.contractId?.contractId() ?? "";
  const base = { vault, hash: event.txHash, at: event.ledgerClosedAt, ledger: event.ledger };
  const data = () => scValToNative(event.value) as Record<string, unknown>;
  switch (name) {
    case "executed": {
      const { nav_before, nav_after } = data();
      return {
        kind: "executed", ...base, role: "default", target: addressOf(event.topic[1]), fn: symbolOf(event.topic[2]) ?? "",
        navBefore: text(nav_before), navAfter: text(nav_after),
      };
    }
    case "role_executed": {
      const { nav_before, nav_after } = data();
      return {
        kind: "executed", ...base, role: symbolOf(event.topic[1]) ?? "", target: addressOf(event.topic[2]),
        fn: symbolOf(event.topic[3]) ?? "", navBefore: text(nav_before), navAfter: text(nav_after),
      };
    }
    case "deposited":
    case "withdrawn": {
      const { amount, shares } = data();
      return { kind: name, ...base, user: addressOf(event.topic[1]), amount: text(amount), shares: text(shares) };
    }
    default:
      return null;
  }
}

/** A vault call carried by a transaction envelope: `execute` (default role) or `execute_as`. */
export interface VaultCall {
  vault: string;
  role: string;
  target: string;
  fn: string;
}

/** The `execute`/`execute_as` call of a single-operation transaction, if it is one. */
export function decodeVaultCall(envelopeXdr: string, networkPassphrase: string): VaultCall | null {
  let parsed;
  try {
    parsed = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  } catch {
    return null;
  }
  const tx = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  const [operation] = tx.operations;
  if (tx.operations.length !== 1 || operation?.type !== "invokeHostFunction") return null;
  const func = operation.func;
  if (func.type !== "hostFunctionTypeInvokeContract") return null;
  const call = func.invokeContract;
  const fn = call.functionName.toString();
  const args = call.args;
  const vault = Address.fromScAddress(call.contractAddress).toString();
  if (fn === "execute" && args.length === 3) {
    return { vault, role: "default", target: addressOf(args[0]), fn: symbolOf(args[1]) ?? "" };
  }
  if (fn === "execute_as" && args.length === 5) {
    return { vault, role: symbolOf(args[1]) ?? "", target: addressOf(args[2]), fn: symbolOf(args[3]) ?? "" };
  }
  return null;
}

/** First failure recorded in a transaction's diagnostic events. */
export type RawFailure = { kind: "contract"; contractId: string | null; code: number } | { kind: "host"; type: string };

/**
 * The contract error where a failed transaction stopped (the first `error`
 * event with a contract code), else the first host error.
 */
export function failureFromDiagnostics(events: xdr.DiagnosticEvent[]): RawFailure | null {
  let host: RawFailure | null = null;
  for (const { event } of events) {
    const topics = event.body.v0.topics;
    if (symbolOf(topics[0]) !== "error") continue;
    const error = topics.find(topic => topic.type === "scvError");
    if (!error || error.type !== "scvError") continue;
    const value = error.value;
    if (value.type === "sceContract") {
      return {
        kind: "contract",
        contractId: event.contractId ? Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(event.contractId)).toString() : null,
        code: Number(value.contractCode),
      };
    }
    host ??= { kind: "host", type: value.type.slice(3) };
  }
  return host;
}
