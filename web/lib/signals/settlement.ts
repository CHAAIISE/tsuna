import {
  Account, Address, BASE_FEE, Operation, Transaction, TransactionBuilder, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, facilitatorKey, rpcServer } from "./config";

/**
 * Verification and settlement of a client-signed SEP-41 `transfer` for both
 * x402 and MPP charge. It follows the checks of `@x402/stellar` and
 * `@stellar/mpp` (exact transfer, address credentials only, bounded expiry,
 * enforce-mode simulation, fee ceiling) but accepts contract payers: the
 * signal budget is an OpenZeppelin smart account whose `__check_auth` and
 * spending limit policy run on-chain, and whose policy emits its own event.
 */

export interface ExpectedTransfer {
  asset: string;
  payTo: string;
  amount: bigint;
  /** Payer bound by the protocol (MPP credential source); x402 takes it from the transfer. */
  from?: string;
  maxLedger: number;
}

export interface VerifiedTransfer {
  payer: string;
  /** Envelope rebuilt with the facilitator as source and simulated resources. */
  prepared: Transaction;
}

export class PaymentRejected extends Error {
  constructor(readonly reason: string, message: string, readonly payer?: string) {
    super(message);
    this.name = "PaymentRejected";
  }
}

/** Ceiling on the network fee the facilitator accepts to pay for one settlement. */
const MAX_SETTLEMENT_FEE_STROOPS = 5_000_000n;
/** SEP-41 / CAP-46 events that move balances; exactly one, the payment, is allowed. */
const BALANCE_EVENTS: Record<string, true> = { transfer: true, mint: true, burn: true, clawback: true };

const addressOf = (value: xdr.ScVal) => Address.fromScVal(value).toString();

function balanceEvents(events: xdr.DiagnosticEvent[]) {
  return events.flatMap(({ event }) => {
    if (event.type.name !== "contract" || event.body.type !== "v0") return [];
    const [name, ...rest] = event.body.v0.topics;
    if (name?.type !== "scvSymbol" || !BALANCE_EVENTS[name.sym.toString()]) return [];
    const contract = event.contractId ? Address.contract(event.contractId.value).toString() : "";
    return [{ name: name.sym.toString(), contract, topics: rest, data: event.body.v0.data }];
  });
}

export async function verifyTransfer(transactionXdr: string, expected: ExpectedTransfer): Promise<VerifiedTransfer> {
  const facilitator = facilitatorKey();
  let tx: Transaction;
  try {
    tx = new Transaction(transactionXdr, NETWORK_PASSPHRASE);
  } catch {
    throw new PaymentRejected("malformed", "The payment is not a valid Stellar transaction");
  }
  const op = tx.operations[0];
  if (tx.operations.length !== 1 || op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") {
    throw new PaymentRejected("wrong_operation", "The payment must be a single contract invocation");
  }
  if (tx.source === facilitator.publicKey() || op.source === facilitator.publicKey()) {
    throw new PaymentRejected("unsafe_source", "The facilitator cannot be a payment source");
  }
  const call = op.func.invokeContract;
  const [fromArg, toArg, amountArg, ...extra] = call.args;
  if (Address.fromScAddress(call.contractAddress).toString() !== expected.asset || call.functionName.toString() !== "transfer"
    || !fromArg || !toArg || !amountArg || extra.length > 0) {
    throw new PaymentRejected("wrong_function", "The payment must be a transfer of the requested asset");
  }
  const payer = addressOf(fromArg);
  if (payer === facilitator.publicKey() || (expected.from && payer !== expected.from)) {
    throw new PaymentRejected("wrong_payer", "The transfer is not from the expected payer", payer);
  }
  if (addressOf(toArg) !== expected.payTo) throw new PaymentRejected("wrong_recipient", "The transfer does not pay the seller", payer);
  if (scValToNative(amountArg) !== expected.amount) throw new PaymentRejected("wrong_amount", "The transfer amount does not match the price", payer);

  const auth = op.auth ?? [];
  if (auth.length === 0) throw new PaymentRejected("missing_auth", "The payment carries no authorization", payer);
  const latest = (await rpcServer.getLatestLedger()).sequence;
  let payerSigned = false;
  for (const entry of auth) {
    const { credentials, rootInvocation } = entry;
    if (credentials.type !== "sorobanCredentialsAddress" && credentials.type !== "sorobanCredentialsAddressV2") {
      throw new PaymentRejected("unsupported_credentials", "Only address authorizations are accepted", payer);
    }
    const signer = Address.fromScAddress(credentials.value.address).toString();
    if (signer === facilitator.publicKey()) throw new PaymentRejected("facilitator_in_auth", "The facilitator cannot authorize the payment", payer);
    const expiration = credentials.value.signatureExpirationLedger;
    if (expiration <= latest || expiration > expected.maxLedger) {
      throw new PaymentRejected("bad_expiration", `Authorization expiry ${expiration} is outside (${latest}, ${expected.maxLedger}]`, payer);
    }
    if (rootInvocation.subInvocations.length > 0) throw new PaymentRejected("sub_invocations", "The authorization must cover the transfer only", payer);
    const fn = rootInvocation.function;
    if (signer === payer && credentials.value.signature.type !== "scvVoid" && fn.type === "sorobanAuthorizedFunctionTypeContractFn"
      && fn.contractFn.equals(call)) {
      payerSigned = true;
    }
  }
  if (!payerSigned) throw new PaymentRejected("missing_payer_signature", "No signed authorization covers this transfer", payer);

  const sequence = (await rpcServer.getAccount(facilitator.publicKey())).sequenceNumber();
  // The simulated and the submitted envelopes must share one sequence number.
  const rebuild = () => new TransactionBuilder(new Account(facilitator.publicKey(), sequence), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .setTimeout(60);
  const simulation = await rpcServer.simulateTransaction(rebuild().build(), undefined, "enforce");
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new PaymentRejected("simulation_failed", rpc.Api.isSimulationError(simulation) ? simulation.error : "Ledger entries need restoration", payer);
  }
  const moves = balanceEvents(simulation.events);
  const [move] = moves;
  if (moves.length !== 1 || !move || move.name !== "transfer" || move.contract !== expected.asset
    || !move.topics[0] || !move.topics[1] || addressOf(move.topics[0]) !== payer || addressOf(move.topics[1]) !== expected.payTo
    || scValToNative(move.data) !== expected.amount) {
    throw new PaymentRejected("unexpected_balance_changes", "The simulation must show exactly the requested transfer", payer);
  }
  const fee = BigInt(simulation.minResourceFee) + BigInt(BASE_FEE);
  if (fee > MAX_SETTLEMENT_FEE_STROOPS) throw new PaymentRejected("fee_exceeds_maximum", `Settlement fee ${fee} exceeds ${MAX_SETTLEMENT_FEE_STROOPS} stroops`, payer);
  const prepared = rpc.assembleTransaction(rebuild().build(), simulation).build();
  return { payer, prepared };
}

export interface Settlement {
  txHash: string;
  success: boolean;
}

/** Signs the rebuilt envelope as facilitator, submits it and waits for the ledger result. */
export async function settleTransfer(prepared: Transaction): Promise<Settlement> {
  prepared.sign(facilitatorKey());
  const sent = await rpcServer.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new PaymentRejected("submission_failed", `Settlement was not accepted: ${sent.status}`);
  const result = await rpcServer.pollTransaction(sent.hash, { attempts: 60, sleepStrategy: () => 1000 });
  return { txHash: sent.hash, success: result.status === rpc.Api.GetTransactionStatus.SUCCESS };
}
