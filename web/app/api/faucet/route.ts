import { z } from "zod";
import { assertRecipient, dripUsdc } from "@/lib/sponsor/faucet";
import { errorResponse, tooManyRequests } from "@/lib/sponsor/http";
import { clientIp, rateLimit, releaseRateLimit } from "@/lib/sponsor/rate-limit";
import { SAC_TRUSTLINE_MISSING, SimulationError, usdcBalance } from "@/lib/sponsor/stellar";

const DAY = 24 * 60 * 60 * 1000;
const body = z.object({ address: z.string().length(56) });

/**
 * Test USDC balance of an address, read on-chain from the Blend USDC contract.
 * `balance` is null when a classic account has no USDC trustline.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const address = new URL(request.url).searchParams.get("address") ?? "";
    assertRecipient(address);
    try {
      return Response.json({ address, balance: (await usdcBalance(address)).toString() });
    } catch (error) {
      if (error instanceof SimulationError && error.contractCode === SAC_TRUSTLINE_MISSING) {
        return Response.json({ address, balance: null });
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}

/** Sends the configured amount of Blend testnet USDC from the faucet stock. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { address } = body.parse(await request.json());
    assertRecipient(address);
    const addressKey = `faucet:${address}`;
    const ipKey = `faucet-ip:${clientIp(request)}`;
    const addressWait = rateLimit(addressKey, 1, DAY);
    if (addressWait) return tooManyRequests(addressWait);
    const ipWait = rateLimit(ipKey, 5, DAY);
    if (ipWait) {
      releaseRateLimit(addressKey);
      return tooManyRequests(ipWait);
    }
    try {
      const { hash, amount } = await dripUsdc(address);
      return Response.json({ hash, amount: amount.toString() });
    } catch (error) {
      // A failed drip (missing trustline, empty stock…) should not cost the daily allowance.
      releaseRateLimit(addressKey);
      releaseRateLimit(ipKey);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
