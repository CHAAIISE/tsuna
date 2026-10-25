import { setTimeout as sleep } from "node:timers/promises";
import {
  Address, Keypair, Operation, SorobanDataBuilder, TransactionBuilder, authorizeEntry, authorizeInvocation, rpc, xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import {
  LeashRefusal, describeError, errorFromEvents, hostErrorFromEvents, parseHostError, parseHostFailure,
  type ErrorSource, type LeashError, type RawContractError,
} from "./errors.js";

export interface TxResult {
  hash: string;
  status: "SUCCESS" | "FAILED";
  error?: LeashError;
  returnValue?: xdr.ScVal;
  ledger?: number;
}

/** Successful simulation with the values the SDK reads from it. */
export interface Simulated {
  tx: Transaction;
  simulation: rpc.Api.SimulateTransactionSuccessResponse;
}

/** Inclusion fee bid per transaction, in stroops. */
const BASE_FEE = "10000";
const TIMEOUT_SECS = 120;
/** Ledgers a signed authorization entry stays valid (~8 minutes). */
const AUTH_VALIDITY_LEDGERS = 100;
/** Resends of an envelope the RPC answered `TRY_AGAIN_LATER`, with a growing pause. */
const SEND_RETRIES = 4;
const SEND_RETRY_MS = 2_000;
/**
 * Margin over a successful simulation's budget. Only the resources actually used plus the
 * non-refundable part of the declared ones are charged; the rest of the fee is refunded.
 */
const INSTRUCTIONS_LEEWAY = 1.1;
const BYTES_LEEWAY = 2_048;
const FEE_LEEWAY = 500_000n;
/** Extra instructions and fee for a refused call submitted with a reconstructed budget. */
const REFUSED_INSTRUCTIONS_MARGIN = 5_000_000;
const REFUSED_FEE_MARGIN = 2_000_000n;
const REFUSED_BYTES_MARGIN = 5_000;
const MAX_INSTRUCTIONS = 400_000_000;

const keyId = (key: xdr.LedgerKey) => key.toXDR("base64");

/** RPC access, signing and submission shared by every client of one network. */
export class Chain {
  constructor(
    readonly server: rpc.Server,
    readonly networkPassphrase: string,
    /** Kind of contract `contractId`, used to name its errors. */
    readonly classify: (contractId: string) => ErrorSource,
  ) {}

  toLeashError(raw: RawContractError, fallback: ErrorSource = "other"): LeashError {
    return describeError(raw.contractId ? this.classify(raw.contractId) : fallback, raw.code);
  }

  async build(source: string, operation: xdr.Operation): Promise<Transaction> {
    return new TransactionBuilder(await this.server.getAccount(source), {
      fee: BASE_FEE, networkPassphrase: this.networkPassphrase,
    }).addOperation(operation).setTimeout(TIMEOUT_SECS).build();
  }

  /** Simulates `operation` from `source`; a contract refusal throws {@link LeashRefusal}. */
  async simulate(source: string, operation: xdr.Operation, fallback: ErrorSource = "other"): Promise<Simulated> {
    const tx = await this.build(source, operation);
    const simulation = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      const raw = parseHostError(simulation.error);
      const error = raw ? this.toLeashError(raw, fallback) : parseHostFailure(simulation.error);
      if (error) throw new LeashRefusal(error, simulation.error);
      throw new Error(`Simulation failed: ${simulation.error}`);
    }
    if (rpc.Api.isSimulationRestore(simulation)) throw new Error("Ledger entries of this call need restoration");
    return { tx, simulation };
  }

  /** Return value of a read-only call. Any funded account can be the simulation source. */
  async read(source: string, operation: xdr.Operation, fallback: ErrorSource = "other"): Promise<xdr.ScVal> {
    const { simulation } = await this.simulate(source, operation, fallback);
    if (!simulation.result) throw new Error("Simulation returned no value");
    return simulation.result.retval;
  }

  /**
   * Simulates, signs and submits `operation` with `source` as transaction source. Authorization
   * entries naming another address are signed by the matching `signers` and simulated again,
   * so the resource budget covers their signature checks. The simulated budget gets a margin:
   * vault state such as hourly loss buckets can grow between simulation and inclusion.
   */
  async invoke(source: Keypair, operation: xdr.Operation, signers: Keypair[] = [], fallback: ErrorSource = "other"): Promise<TxResult> {
    let simulated = await this.simulate(source.publicKey(), operation, fallback);
    const entries = simulated.simulation.result?.auth ?? [];
    if (entries.some(entry => entry.credentials.type !== "sorobanCredentialsSourceAccount")) {
      const auth = await this.signEntries(entries, signers);
      const func = hostFunction(operation);
      simulated = await this.simulate(source.publicKey(), Operation.invokeHostFunction({ func, auth }), fallback);
    }
    const data = simulated.simulation.transactionData.build();
    const { instructions, diskReadBytes, writeBytes } = data.resources;
    const padded = new SorobanDataBuilder(data)
      .setResources(
        Math.min(Math.ceil(instructions * INSTRUCTIONS_LEEWAY), MAX_INSTRUCTIONS),
        diskReadBytes + BYTES_LEEWAY,
        writeBytes + BYTES_LEEWAY,
      )
      .setResourceFee(data.resourceFee + FEE_LEEWAY)
      .build();
    const tx = rpc.assembleTransaction(simulated.tx, simulated.simulation).setSorobanData(padded).build();
    return this.submit(source, tx, fallback);
  }

  /**
   * Signs every address-credential entry (legacy or CAP-71 `addressV2`, which recent RPCs
   * return) with the signer it names.
   */
  async signEntries(entries: xdr.SorobanAuthorizationEntry[], signers: Keypair[]): Promise<xdr.SorobanAuthorizationEntry[]> {
    const validUntil = (await this.server.getLatestLedger()).sequence + AUTH_VALIDITY_LEDGERS;
    return Promise.all(entries.map(async entry => {
      const { credentials } = entry;
      if (credentials.type === "sorobanCredentialsSourceAccount") return entry;
      if (credentials.type === "sorobanCredentialsAddressWithDelegates") {
        throw new Error("Delegated authorization entries are not supported");
      }
      const named = Address.fromScAddress(credentials.value.address).toString();
      const signer = signers.find(key => key.publicKey() === named);
      if (!signer) throw new Error(`No signer provided for the authorization of ${named}`);
      return authorizeEntry(entry, signer, validUntil, this.networkPassphrase);
    }));
  }

  /**
   * Signs `tx` with `source`, submits it and waits for its final status. A `TRY_AGAIN_LATER`
   * answer (the RPC queue is busy for this account) resends the same envelope a few times.
   */
  async submit(source: Keypair, tx: Transaction, fallback: ErrorSource = "other"): Promise<TxResult> {
    tx.sign(source);
    let sent = await this.server.sendTransaction(tx);
    for (let retry = 1; sent.status === "TRY_AGAIN_LATER" && retry <= SEND_RETRIES; retry++) {
      await sleep(retry * SEND_RETRY_MS);
      sent = await this.server.sendTransaction(tx);
    }
    if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
      const raw = errorFromEvents(sent.diagnosticEvents ?? []);
      if (raw) throw new LeashRefusal(this.toLeashError(raw, fallback), `Submission ${sent.status}`);
      throw new Error(`Submission ${sent.status}: ${sent.errorResult?.toXDR("base64") ?? sent.hash}`);
    }
    const result = await this.server.pollTransaction(sent.hash, {
      attempts: 60, sleepStrategy: rpc.BasicSleepStrategy,
    });
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash: sent.hash, status: "SUCCESS", ledger: result.ledger,
        ...(result.returnValue ? { returnValue: result.returnValue } : {}),
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const events = result.diagnosticEventsXdr ?? [];
      const raw = errorFromEvents(events);
      const error = raw ? this.toLeashError(raw, fallback) : hostErrorFromEvents(events);
      return { hash: sent.hash, status: "FAILED", ledger: result.ledger, ...(error ? { error } : {}) };
    }
    throw new Error(`Transaction ${sent.hash} not found after submission`);
  }

  /**
   * Submits a call the contract refuses in simulation, so the refusal is recorded on-chain as a
   * FAILED transaction carrying the contract error. A failed preflight returns no budget, so the
   * footprint is the union of the footprints of `siblings` (valid simulations touching the same
   * state), with every entry of `writable` contracts made read-write, plus the authorization
   * entries of `member`; resources are the siblings' sums plus a margin.
   */
  async submitRefused(opts: {
    source: Keypair;
    member: Keypair;
    operation: xdr.Operation;
    siblings: xdr.Operation[];
    writable: string[];
    fallback?: ErrorSource;
  }): Promise<TxResult> {
    const { source, member, operation, siblings, writable, fallback = "other" } = opts;
    const simulations = await Promise.all(siblings.map(op => this.simulate(source.publicKey(), op, fallback)));
    const readOnly = new Map<string, xdr.LedgerKey>();
    const readWrite = new Map<string, xdr.LedgerKey>();
    let instructions = REFUSED_INSTRUCTIONS_MARGIN;
    let diskReadBytes = REFUSED_BYTES_MARGIN;
    let writeBytes = REFUSED_BYTES_MARGIN;
    let resourceFee = REFUSED_FEE_MARGIN;
    const writableContracts = new Set(writable);
    // Contract data of a writable contract (its instance included) becomes read-write.
    const isWritable = (key: xdr.LedgerKey) =>
      key.type === "contractData" && writableContracts.has(Address.fromScAddress(key.value.contract).toString());
    for (const { simulation } of simulations) {
      const data = simulation.transactionData.build();
      const { footprint } = data.resources;
      for (const key of footprint.readWrite) readWrite.set(keyId(key), key);
      for (const key of footprint.readOnly) (isWritable(key) ? readWrite : readOnly).set(keyId(key), key);
      instructions += data.resources.instructions;
      diskReadBytes += data.resources.diskReadBytes;
      writeBytes += data.resources.writeBytes;
      resourceFee += BigInt(simulation.minResourceFee);
    }
    const host = hostFunction(operation);
    if (host.type !== "hostFunctionTypeInvokeContract") throw new Error("Expected a contract invocation");
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(host.value),
      subInvocations: [],
    });
    let auth: xdr.SorobanAuthorizationEntry;
    if (member.publicKey() === source.publicKey()) {
      auth = new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: invocation,
      });
    } else {
      const validUntilLedgerSeq = (await this.server.getLatestLedger()).sequence + AUTH_VALIDITY_LEDGERS;
      auth = await authorizeInvocation({
        signer: member, validUntilLedgerSeq, invocation, publicKey: member.publicKey(), networkPassphrase: this.networkPassphrase,
      });
      const { credentials } = auth;
      if (credentials.type !== "sorobanCredentialsAddress" && credentials.type !== "sorobanCredentialsAddressV2") {
        throw new Error("Expected address credentials");
      }
      // The host reads the member's account to check the signature and consumes the nonce.
      const account = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: member.xdrAccountId() }));
      readOnly.set(keyId(account), account);
      const nonce = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
        contract: new Address(member.publicKey()).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: credentials.value.nonce })),
        durability: xdr.ContractDataDurability.temporary,
      }));
      readWrite.set(keyId(nonce), nonce);
    }
    for (const id of readWrite.keys()) readOnly.delete(id);
    const sorobanData = new SorobanDataBuilder()
      .setFootprint([...readOnly.values()], [...readWrite.values()])
      .setResources(Math.min(instructions, MAX_INSTRUCTIONS), diskReadBytes, writeBytes)
      .setResourceFee(resourceFee)
      .build();
    const tx = new TransactionBuilder(await this.server.getAccount(source.publicKey()), {
      fee: BASE_FEE, networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.invokeHostFunction({ func: host, auth: [auth] }))
      .setSorobanData(sorobanData)
      .setTimeout(TIMEOUT_SECS)
      .build();
    return this.submit(source, tx, fallback);
  }
}

export function hostFunction(operation: xdr.Operation): xdr.HostFunction {
  if (operation.body.type !== "invokeHostFunction") throw new Error("Expected a contract invocation");
  return operation.body.value.hostFunction;
}
