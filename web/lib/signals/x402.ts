import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type {
  Network, PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator, SettleResponse, VerifyResponse,
} from "@x402/core/types";
import type { RouteConfig } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { NETWORK, PAY_TO, USDC, facilitatorKey, rpcServer, signalPrice, toStroops } from "./config";
import { PaymentRejected, settleTransfer, verifyTransfer } from "./settlement";

/** Estimated ledger close time, used to bound authorization expiry like `@x402/stellar`. */
const LEDGER_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 60;

/**
 * Self-hosted `exact` facilitator for Stellar. The public testnet facilitator
 * listed in the Stellar docs (x402.org) caps settlement fees at 50,000 stroops
 * and only expects SAC transfer events, so it rejects payments from a smart
 * account whose `__check_auth` runs a spending limit policy. Fees are paid by
 * `LEASH_FACILITATOR_SECRET`.
 */
class SmartAccountExactStellarFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "stellar:*";

  getExtra(): Record<string, unknown> {
    return { areFeesSponsored: true };
  }

  getSigners(): string[] {
    return [facilitatorKey().publicKey()];
  }

  private async check(payload: PaymentPayload, requirements: PaymentRequirements) {
    if (payload.x402Version !== 2) throw new PaymentRejected("invalid_x402_version", "Only x402 v2 is supported");
    if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") throw new PaymentRejected("unsupported_scheme", "Only the exact scheme is supported");
    if (payload.accepted.network !== requirements.network || requirements.network !== NETWORK) throw new PaymentRejected("network_mismatch", "Wrong network");
    const transaction = payload.payload.transaction;
    if (typeof transaction !== "string") throw new PaymentRejected("malformed", "Missing transaction");
    const latest = (await rpcServer.getLatestLedger()).sequence;
    return verifyTransfer(transaction, {
      asset: requirements.asset,
      payTo: requirements.payTo,
      amount: BigInt(requirements.amount),
      maxLedger: latest + Math.ceil(requirements.maxTimeoutSeconds / LEDGER_SECONDS) + 2,
    });
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const { payer } = await this.check(payload, requirements);
      return { isValid: true, payer };
    } catch (error) {
      if (!(error instanceof PaymentRejected)) throw error;
      return { isValid: false, invalidReason: error.reason, invalidMessage: error.message, ...(error.payer ? { payer: error.payer } : {}) };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network as Network;
    try {
      const { payer, prepared } = await this.check(payload, requirements);
      const { txHash, success } = await settleTransfer(prepared);
      return success
        ? { success, transaction: txHash, network, payer, amount: requirements.amount }
        : { success, transaction: txHash, network, payer, errorReason: "transaction_failed" };
    } catch (error) {
      if (!(error instanceof PaymentRejected)) throw error;
      return { success: false, transaction: "", network, errorReason: error.reason, errorMessage: error.message, ...(error.payer ? { payer: error.payer } : {}) };
    }
  }
}

const facilitator = new x402Facilitator().register(NETWORK, new SmartAccountExactStellarFacilitator());
const facilitatorClient: FacilitatorClient = {
  verify: (payload, requirements) => facilitator.verify(payload, requirements),
  settle: (payload, requirements) => facilitator.settle(payload, requirements),
  getSupported: async () => {
    const supported = facilitator.getSupported();
    // x402Facilitator types its registered networks as plain strings; they are CAIP-2 ids.
    return { ...supported, kinds: supported.kinds.map(({ extra, ...kind }) => ({ ...kind, network: kind.network as Network, ...(extra ? { extra } : {}) })) };
  },
};

export const x402Server = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactStellarScheme());

export function ratesRoute(): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      payTo: PAY_TO,
      price: { amount: toStroops(signalPrice()).toString(), asset: USDC },
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    },
    description: "Blend testnet pool rates for USDC and XLM",
    mimeType: "application/json",
  };
}
