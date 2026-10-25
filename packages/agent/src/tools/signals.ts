import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { charge } from "@stellar/mpp/charge";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { Credential, Method, Receipt } from "mppx";
import { Mppx } from "mppx/client";
import {
  PolicyRefusalError, signBudgetTransfer, submitRefusedTransfer, type SignalBudget,
} from "./budget-payment.js";
import { policyRefusalFromCodes, type PolicyRefusalName } from "./refusal.js";

export type SignalKind = "rates" | "risk";
export type PaymentProtocol = "x402" | "mpp";

const NETWORK = "stellar:testnet";
/** Ledger close time used to turn payment deadlines into authorization expiry ledgers. */
const LEDGER_SECONDS = 5;

export interface BuySignalOptions {
  /** Origin of the Leash web app serving `/api/signals/*`. */
  baseUrl: string;
  budget: SignalBudget;
  /** SEP-41 contract the budget pays with (Blend testnet USDC). */
  asset: string;
  /** Highest price accepted for one call, in stroops of `asset`. */
  maxPrice: bigint;
  rpcServer?: rpc.Server;
  networkPassphrase?: string;
  /**
   * Account that submits a refused payment as a transaction so the policy
   * refusal is recorded on-chain; without it the refusal comes from simulation.
   */
  refusalSubmitter?: Keypair;
  fetch?: typeof globalThis.fetch;
}

export interface SignalPaid {
  status: "paid";
  kind: SignalKind;
  protocol: PaymentProtocol;
  data: unknown;
  paymentTxHash: string;
}

export interface SignalRefused {
  status: "refused";
  kind: SignalKind;
  protocol: PaymentProtocol;
  reason: PolicyRefusalName;
  code: number;
  /** FAILED transaction carrying the policy error, when a refusal submitter was given. */
  failedTxHash: string | null;
  simulationError: string;
}

export type SignalPurchase = SignalPaid | SignalRefused;

/** Which payment protocol a `402 Payment Required` response speaks. */
export function paymentProtocol(response: Pick<Response, "status" | "headers">): PaymentProtocol | null {
  if (response.status !== 402) return null;
  if (response.headers.get("PAYMENT-REQUIRED")) return "x402";
  if (/^Payment\s/i.test(response.headers.get("WWW-Authenticate") ?? "")) return "mpp";
  return null;
}

/** Keeps the x402 offers the budget can pay: Stellar testnet, budget asset, sponsored fees, price within the cap. */
export function payableRequirements(requirements: PaymentRequirements[], asset: string, maxPrice: bigint): PaymentRequirements[] {
  return requirements.filter(requirement => requirement.scheme === "exact"
    && requirement.network === NETWORK
    && requirement.asset === asset
    && requirement.extra.areFeesSponsored === true
    && /^\d+$/.test(requirement.amount) && BigInt(requirement.amount) > 0n && BigInt(requirement.amount) <= maxPrice);
}

/** Last ledger at which a payment signed now may still be settled before `deadline` (unix seconds). */
export function expiryLedger(latestLedger: number, nowSeconds: number, deadlineSeconds: number): number {
  return latestLedger + Math.max(Math.ceil((deadlineSeconds - nowSeconds) / LEDGER_SECONDS), 1);
}

interface Context {
  server: rpc.Server;
  passphrase: string;
  options: BuySignalOptions;
}

/** x402 `exact` client scheme paying from the signal budget smart account. */
class SignalBudgetExactScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  constructor(private readonly context: Context) {}

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements): Promise<PaymentPayloadResult> {
    const { server, passphrase, options } = this.context;
    const latest = (await server.getLatestLedger()).sequence;
    const now = Math.floor(Date.now() / 1000);
    const transaction = await signBudgetTransfer(server, passphrase, options.budget, {
      asset: requirements.asset,
      payTo: requirements.payTo,
      amount: BigInt(requirements.amount),
      validUntilLedger: expiryLedger(latest, now, now + requirements.maxTimeoutSeconds),
    });
    return { x402Version, payload: { transaction: transaction.toXDR() } };
  }
}

async function payWithX402(url: string, first: Response, context: Context) {
  const { options } = context;
  const fetcher = options.fetch ?? globalThis.fetch;
  const client = new x402Client()
    .register(NETWORK, new SignalBudgetExactScheme(context))
    .setSpendControls({ allowedAssets: [{ network: NETWORK, asset: options.asset, maxAmountPerPayment: options.maxPrice.toString() }] })
    .registerPolicy((_version, requirements) => payableRequirements(requirements, options.asset, options.maxPrice));
  const http = new x402HTTPClient(client);
  const paymentRequired = http.getPaymentRequiredResponse(name => first.headers.get(name), await first.json().catch(() => undefined));
  const payload = await http.createPaymentPayload(paymentRequired);
  const paid = await fetcher(url, { headers: http.encodePaymentSignatureHeader(payload) });
  const settlement = paid.headers.get("PAYMENT-RESPONSE") ? http.getPaymentSettleResponse(name => paid.headers.get(name)) : undefined;
  if (!paid.ok || !settlement?.success) {
    throw new Error(`x402 payment not settled (${paid.status}): ${settlement?.errorReason ?? await paid.text()}`);
  }
  return { data: await paid.json() as unknown, paymentTxHash: settlement.transaction };
}

async function payWithMpp(url: string, context: Context) {
  const { server, passphrase, options } = context;
  const method = Method.toClient(charge, {
    async createCredential({ challenge }) {
      const { amount, currency, recipient, methodDetails } = challenge.request;
      if (methodDetails?.network !== NETWORK || methodDetails.feePayer !== true || !(methodDetails.credentialTypes ?? ["transaction"]).includes("transaction")) {
        throw new Error("The MPP challenge must be a sponsored Stellar testnet charge");
      }
      if (currency !== options.asset || !/^\d+$/.test(amount) || BigInt(amount) <= 0n || BigInt(amount) > options.maxPrice) {
        throw new Error(`Refusing MPP charge of ${amount} ${currency}`);
      }
      if (!challenge.expires) throw new Error("The MPP challenge has no expiry");
      const deadline = Math.floor(new Date(challenge.expires).getTime() / 1000);
      const latest = (await server.getLatestLedger()).sequence;
      const transaction = await signBudgetTransfer(server, passphrase, options.budget, {
        asset: currency,
        payTo: recipient,
        amount: BigInt(amount),
        validUntilLedger: expiryLedger(latest, Math.floor(Date.now() / 1000), deadline),
        maxTime: deadline,
      });
      return Credential.serialize({
        challenge,
        payload: { type: "transaction", transaction: transaction.toXDR() },
        source: `did:pkh:${NETWORK}:${options.budget.account}`,
      });
    },
  });
  const mppx = Mppx.create({ methods: [method], polyfill: false, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const paid = await mppx.fetch(url);
  if (!paid.ok) throw new Error(`MPP payment not settled (${paid.status}): ${await paid.text()}`);
  return { data: await paid.json() as unknown, paymentTxHash: Receipt.fromResponse(paid).reference };
}

/**
 * Buys one Leash signal, paying from the signal budget with the agent session
 * key: `rates` is sold over x402 and `risk` over an MPP charge, both settled in
 * USDC on Stellar testnet. When the budget's spending limit policy refuses the
 * payment, the result is a typed refusal instead of an exception.
 */
export async function buySignal(kind: SignalKind, options: BuySignalOptions): Promise<SignalPurchase> {
  const context: Context = {
    server: options.rpcServer ?? new rpc.Server("https://soroban-testnet.stellar.org"),
    passphrase: options.networkPassphrase ?? Networks.TESTNET,
    options,
  };
  const url = new URL(`/api/signals/${kind}`, options.baseUrl).toString();
  const first = await (options.fetch ?? globalThis.fetch)(url);
  const protocol = paymentProtocol(first);
  if (!protocol) throw new Error(`Expected a 402 payment challenge from ${url}, got ${first.status}`);
  try {
    const paid = protocol === "x402" ? await payWithX402(url, first, context) : await payWithMpp(url, context);
    return { status: "paid", kind, protocol, ...paid };
  } catch (error) {
    const refused = error instanceof PolicyRefusalError ? error : error instanceof Error && error.cause instanceof PolicyRefusalError ? error.cause : undefined;
    if (!refused) throw error;
    let failedTxHash: string | null = null;
    let { refusal } = refused;
    if (options.refusalSubmitter) {
      const onChain = await submitRefusedTransfer(context.server, context.passphrase, options.budget, refused, options.refusalSubmitter);
      refusal = policyRefusalFromCodes(onChain.contractCodes) ?? refusal;
      failedTxHash = onChain.txHash;
    }
    return { status: "refused", kind, protocol, reason: refusal.name, code: refusal.code, failedTxHash, simulationError: refused.simulationError };
  }
}
