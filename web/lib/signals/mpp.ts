import { DEFAULT_CHALLENGE_EXPIRY, DEFAULT_LEDGER_CLOSE_TIME, toBaseUnits } from "@stellar/mpp";
import { charge } from "@stellar/mpp/charge";
import { Errors, Method, Receipt } from "mppx";
import { Expires, Mppx } from "mppx/server";
import { NETWORK, PAY_TO, USDC, USDC_DECIMALS, rpcServer, signalPrice } from "./config";
import { PaymentRejected, settleTransfer, verifyTransfer } from "./settlement";

/** Same skew `@stellar/mpp` tolerates between challenge expiry and authorization expiry. */
const AUTH_EXPIRATION_LEDGER_SKEW = 10;

/**
 * Payer of a `did:pkh:stellar:<network>:<address>` credential source. Unlike
 * `@stellar/mpp`, which only accepts `G…` accounts, contract accounts are
 * accepted so the signal budget smart account can pay.
 */
export function payerFromSource(source: string | undefined): string {
  const match = /^did:pkh:stellar:([a-z]+):([GC][A-Z2-7]{55})$/.exec(source ?? "");
  if (!match || `stellar:${match[1]}` !== NETWORK) throw new Errors.InvalidPayloadError({ reason: "Credential source must be did:pkh:stellar:testnet:<address>" });
  return match[2] as string;
}

/**
 * Stellar `charge` intent (draft-stellar-charge-00, method schema from
 * `@stellar/mpp`) in sponsored pull mode: the client signs only the Soroban
 * authorization entry and the server settles with its own account as source.
 */
const stellarCharge = Method.toServer(charge, {
  defaults: { currency: USDC, recipient: PAY_TO },
  request({ request }) {
    return {
      ...request,
      amount: toBaseUnits(request.amount, USDC_DECIMALS),
      methodDetails: { network: NETWORK, feePayer: true, credentialTypes: ["transaction"] },
    };
  },
  async verify({ credential }) {
    const { challenge, payload, source } = credential;
    if (payload.type !== "transaction") throw new Errors.InvalidPayloadError({ reason: "Sponsored charges require a signed transaction" });
    if (!challenge.expires) throw new Errors.InvalidChallengeError({ reason: "Challenge has no expiry" });
    const secondsLeft = Math.floor((new Date(challenge.expires).getTime() - Date.now()) / 1000);
    if (secondsLeft <= 0) throw new Errors.PaymentExpiredError({ expires: challenge.expires });
    const latest = (await rpcServer.getLatestLedger()).sequence;
    try {
      const { prepared } = await verifyTransfer(payload.transaction, {
        asset: challenge.request.currency,
        payTo: challenge.request.recipient,
        amount: BigInt(challenge.request.amount),
        from: payerFromSource(source),
        maxLedger: latest + Math.ceil(secondsLeft / DEFAULT_LEDGER_CLOSE_TIME) + AUTH_EXPIRATION_LEDGER_SKEW,
      });
      const { txHash, success } = await settleTransfer(prepared);
      if (!success) throw new PaymentRejected("transaction_failed", `Settlement transaction ${txHash} failed`);
      return Receipt.from({ method: "stellar", reference: txHash, status: "success", timestamp: new Date().toISOString() });
    } catch (error) {
      if (error instanceof PaymentRejected) throw new Errors.VerificationFailedError({ reason: `${error.reason}: ${error.message}` });
      throw error;
    }
  },
});

type SignalMppx = Mppx.Mppx<readonly [typeof stellarCharge]>;

let instance: SignalMppx | undefined;
function create(): SignalMppx {
  const secretKey = process.env.MPP_SECRET;
  if (!secretKey || Buffer.byteLength(secretKey) < 32) throw new Error("MPP_SECRET must hold at least 32 bytes");
  return Mppx.create({ secretKey, methods: [stellarCharge] });
}

/** Charges one signal call through MPP; the handler runs only once payment settled. */
export async function chargeSignal(request: Request, description: string, handler: () => Promise<Response>): Promise<Response> {
  instance ??= create();
  const result = await instance.charge({ amount: signalPrice(), description, expires: Expires.seconds(DEFAULT_CHALLENGE_EXPIRY) })(request);
  if (result.status === 402) return result.challenge;
  return result.withReceipt(await handler());
}
