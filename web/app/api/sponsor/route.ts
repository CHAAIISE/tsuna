import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { z } from "zod";
import { fromBase64Url } from "@/lib/passkey/encoding";
import { errorResponse, tooManyRequests } from "@/lib/sponsor/http";
import { clientIp, rateLimit } from "@/lib/sponsor/rate-limit";
import { deployAccount, feeBump, prepareInvocation, prepareTrustline, submitInvocation } from "@/lib/sponsor/relayer";
import { NETWORK_PASSPHRASE } from "@/lib/sponsor/stellar";

const HOUR = 60 * 60 * 1000;
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(400);
const invocation = {
  account: z.string().length(56),
  contract: z.string().length(56),
  method: z.string().max(32),
  args: z.array(z.string().max(4096)).max(16),
};

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deploy"), publicKey: base64Url, credentialId: base64Url }),
  z.object({ action: z.literal("prepare"), ...invocation }),
  z.object({ action: z.literal("submit"), ...invocation, authEntries: z.array(z.string().max(16_384)).min(1).max(8) }),
  z.object({ action: z.literal("trustline"), address: z.string().length(56) }),
  z.object({ action: z.literal("fee-bump"), xdr: z.string().max(32_768) }),
]);

/** Fee sponsorship for passkey accounts and classic wallets on testnet. */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = body.parse(await request.json());
    const ip = clientIp(request);
    switch (input.action) {
      case "deploy": {
        const wait = rateLimit(`deploy:${ip}`, 20, HOUR);
        if (wait) return tooManyRequests(wait);
        const { account, hash } = await deployAccount(fromBase64Url(input.publicKey), fromBase64Url(input.credentialId));
        return Response.json({ account, hash });
      }
      case "prepare": {
        const wait = rateLimit(`prepare:${input.account}`, 60, HOUR);
        if (wait) return tooManyRequests(wait);
        return Response.json(await prepareInvocation(input));
      }
      case "submit": {
        const wait = rateLimit(`submit:${input.account}`, 20, HOUR) || rateLimit(`submit-ip:${ip}`, 40, HOUR);
        if (wait) return tooManyRequests(wait);
        return Response.json(await submitInvocation(input, input.authEntries));
      }
      case "trustline": {
        const wait = rateLimit(`trustline:${input.address}`, 10, HOUR);
        if (wait) return tooManyRequests(wait);
        return Response.json(await prepareTrustline(input.address));
      }
      case "fee-bump": {
        const parsed = TransactionBuilder.fromXDR(input.xdr, NETWORK_PASSPHRASE);
        const source = parsed instanceof FeeBumpTransaction ? parsed.feeSource : parsed.source;
        const wait = rateLimit(`fee-bump:${source}`, 10, HOUR) || rateLimit(`fee-bump-ip:${ip}`, 20, HOUR);
        if (wait) return tooManyRequests(wait);
        return Response.json(await feeBump(input.xdr));
      }
    }
  } catch (error) {
    return errorResponse(error);
  }
}
