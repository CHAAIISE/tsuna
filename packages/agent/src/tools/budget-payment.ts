import {
  Account, Address, BASE_FEE, Keypair, Operation, SorobanDataBuilder, TransactionBuilder, authorizeEntry,
  hash, nativeToScVal, rpc, scValToNative, xdr, type Transaction,
} from "@stellar/stellar-sdk";
import { policyRefusal, type PolicyRefusal } from "./refusal.js";

/** Context rule of the session key in `contracts/signal_budget`. */
export const SESSION_RULE_ID = 1;
/**
 * Placeholder envelope source used by x402 and sponsored MPP payloads: the
 * settling party rebuilds the envelope with its own account and only keeps the
 * signed authorization entry.
 */
export const PLACEHOLDER_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * The OpenZeppelin smart account that pays for signals. The agent holds the
 * session key; it never controls the account itself, so every transfer it
 * signs is checked on-chain against the account's spending limit policy.
 */
export interface SignalBudget {
  account: string;
  verifier: string;
  sessionKey: Keypair;
}

export interface BudgetTransferRequest {
  asset: string;
  payTo: string;
  amount: bigint;
  validUntilLedger: number;
  /** Unix seconds after which the envelope is invalid; defaults to a 180 s timeout. */
  maxTime?: number;
}

export class PolicyRefusalError extends Error {
  constructor(
    readonly refusal: PolicyRefusal,
    readonly simulationError: string,
    readonly transaction: Transaction,
    readonly request: BudgetTransferRequest,
  ) {
    super(`Payment refused by the signal budget policy: ${refusal.name} (${refusal.code})`);
    this.name = "PolicyRefusalError";
  }
}

const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

/**
 * `AuthPayload` expected by the OZ smart account: the session signer signs the
 * SHA-256 of the XDR-encoded `AuthDigestPreimage { account, context_rule_ids,
 * signature_payload }`; the rule ids select the session rule for the single
 * transfer context. Struct fields are encoded as maps sorted by key.
 */
export function sessionAuthPayload(budget: SignalBudget, signaturePayload: Uint8Array): xdr.ScVal {
  const ruleIds = xdr.ScVal.scvVec([xdr.ScVal.scvU32(SESSION_RULE_ID)]);
  const digest = hash(xdr.ScVal.scvMap([
    field("account", new Address(budget.account).toScVal()),
    field("context_rule_ids", ruleIds),
    field("signature_payload", xdr.ScVal.scvBytes(signaturePayload)),
  ]).toXdr());
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(budget.verifier).toScVal(),
    xdr.ScVal.scvBytes(budget.sessionKey.rawPublicKey()),
  ]);
  return xdr.ScVal.scvMap([
    field("context_rule_ids", ruleIds),
    field("signers", xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signer, val: xdr.ScVal.scvBytes(budget.sessionKey.sign(digest)) })])),
  ]);
}

function transferEnvelope(source: Account, request: BudgetTransferRequest, networkPassphrase: string, args: xdr.ScVal[], auth?: xdr.SorobanAuthorizationEntry) {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({
    contractAddress: new Address(request.asset).toScAddress(), functionName: "transfer", args,
  }));
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.invokeHostFunction({ func, auth: auth ? [auth] : [] }));
  return (request.maxTime ? builder.setTimebounds(0, request.maxTime) : builder.setTimeout(180)).build();
}

function transferArgs(budget: SignalBudget, request: BudgetTransferRequest, amount: bigint) {
  return [new Address(budget.account).toScVal(), new Address(request.payTo).toScVal(), nativeToScVal(amount, { type: "i128" })];
}

/** Recent RPCs return CAP-71 `addressV2` credentials; both carry the same address fields. */
function isAddressCredentials(credentials: xdr.SorobanCredentials): credentials is xdr.SorobanCredentialsAddress | xdr.SorobanCredentialsAddressV2 {
  return credentials.type === "sorobanCredentialsAddress" || credentials.type === "sorobanCredentialsAddressV2";
}

/** Refuses to sign anything but the exact requested transfer out of the budget. */
function exactTransferEntry(entries: xdr.SorobanAuthorizationEntry[], budget: SignalBudget, request: BudgetTransferRequest) {
  const [entry, ...rest] = entries;
  if (!entry || rest.length > 0) throw new Error(`Expected one authorization entry, got ${entries.length}`);
  const { credentials, rootInvocation } = entry;
  if (!isAddressCredentials(credentials) || Address.fromScAddress(credentials.value.address).toString() !== budget.account) {
    throw new Error("The authorization entry is not for the signal budget");
  }
  const fn = rootInvocation.function;
  if (rootInvocation.subInvocations.length > 0 || fn.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("The authorization tree must contain only the transfer");
  }
  const [from, to, amount, ...extra] = fn.contractFn.args;
  if (Address.fromScAddress(fn.contractFn.contractAddress).toString() !== request.asset
    || fn.contractFn.functionName.toString() !== "transfer" || !from || !to || !amount || extra.length > 0
    || Address.fromScVal(from).toString() !== budget.account || Address.fromScVal(to).toString() !== request.payTo
    || scValToNative(amount) !== request.amount) {
    throw new Error("The authorization does not match the requested payment");
  }
  return entry;
}

const signWithSession = (budget: SignalBudget) =>
  async (_preimage: xdr.HashIdPreimage, payload: Uint8Array) => ({ signatureScVal: sessionAuthPayload(budget, payload) });

/**
 * Builds the SEP-41 transfer from the budget, signs its authorization entry with
 * the session key and re-simulates it in enforce mode, which runs the smart
 * account's `__check_auth` and the spending limit policy. A policy refusal is
 * thrown as {@link PolicyRefusalError} before anything reaches the seller.
 */
export async function signBudgetTransfer(server: rpc.Server, networkPassphrase: string, budget: SignalBudget, request: BudgetTransferRequest): Promise<Transaction> {
  const args = transferArgs(budget, request, request.amount);
  const recorded = await server.simulateTransaction(transferEnvelope(new Account(PLACEHOLDER_SOURCE, "0"), request, networkPassphrase, args));
  if (!rpc.Api.isSimulationSuccess(recorded)) {
    throw new Error(`Payment simulation failed: ${rpc.Api.isSimulationError(recorded) ? recorded.error : "restore required"}`);
  }
  const entry = exactTransferEntry(recorded.result?.auth ?? [], budget, request);
  const signed = await authorizeEntry(entry, signWithSession(budget), request.validUntilLedger, networkPassphrase);
  const candidate = transferEnvelope(new Account(PLACEHOLDER_SOURCE, "0"), request, networkPassphrase, args, signed);
  const enforced = await server.simulateTransaction(candidate, undefined, "enforce");
  if (!rpc.Api.isSimulationSuccess(enforced)) {
    const error = rpc.Api.isSimulationError(enforced) ? enforced.error : "restore required";
    const refusal = policyRefusal(error);
    if (refusal) throw new PolicyRefusalError(refusal, error, candidate, request);
    throw new Error(`Payment authorization rejected in simulation: ${error}`);
  }
  return rpc.assembleTransaction(candidate, enforced).build();
}

/**
 * Submits a payment the policy refused so the refusal is recorded on-chain.
 * A failing simulation carries no resource estimate, so resources come from a
 * probe of the same transfer reduced to one stroop: same nonce and ledger keys
 * (balances, account rules, policy history) but still under the limit.
 */
export async function submitRefusedTransfer(server: rpc.Server, networkPassphrase: string, budget: SignalBudget, refused: PolicyRefusalError, submitter: Keypair) {
  const { request } = refused;
  const op = refused.transaction.operations[0];
  const entry = op?.type === "invokeHostFunction" ? op.auth?.[0] : undefined;
  if (!op || op.type !== "invokeHostFunction" || !entry || !isAddressCredentials(entry.credentials)) {
    throw new Error("The refused payment has no address authorization");
  }
  const probeArgs = transferArgs(budget, request, 1n);
  const probeEntry = await authorizeEntry(new xdr.SorobanAuthorizationEntry({
    credentials: entry.credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: new Address(request.asset).toScAddress(), functionName: "transfer", args: probeArgs,
      })),
      subInvocations: [],
    }),
  }), signWithSession(budget), request.validUntilLedger, networkPassphrase);
  const probe = await server.simulateTransaction(
    transferEnvelope(new Account(PLACEHOLDER_SOURCE, "0"), request, networkPassphrase, probeArgs, probeEntry), undefined, "enforce");
  if (!rpc.Api.isSimulationSuccess(probe)) {
    throw new Error(`Cannot size the refused payment: ${rpc.Api.isSimulationError(probe) ? probe.error : "restore required"}`);
  }
  const data = probe.transactionData.build();
  const { instructions, diskReadBytes, writeBytes } = data.resources;
  const sized = new SorobanDataBuilder(data)
    .setResources(instructions * 2, diskReadBytes, writeBytes)
    .setResourceFee(data.resourceFee * 2n)
    .build();
  const tx = new TransactionBuilder(await server.getAccount(submitter.publicKey()), {
    fee: (BigInt(BASE_FEE) + sized.resourceFee).toString(), networkPassphrase, sorobanData: sized,
  }).addOperation(Operation.invokeHostFunction({ func: op.func, auth: [entry] })).setTimeout(120).build();
  tx.sign(submitter);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== "PENDING") throw new Error(`Refused payment was not accepted for inclusion: ${sent.status}`);
  const result = await server.pollTransaction(sent.hash, { attempts: 60, sleepStrategy: () => 1000 });
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Refused payment unexpectedly succeeded: ${sent.hash}`);
  if (result.status !== rpc.Api.GetTransactionStatus.FAILED) throw new Error(`Refused payment not found: ${sent.hash}`);
  const contractCodes = new Set<number>();
  for (const event of result.diagnosticEventsXdr ?? []) {
    if (event.event.body.type !== "v0") continue;
    for (const topic of event.event.body.v0.topics) {
      if (topic.type === "scvError" && topic.error.type === "sceContract") contractCodes.add(topic.error.contractCode);
    }
  }
  return { txHash: sent.hash, contractCodes: [...contractCodes] };
}
