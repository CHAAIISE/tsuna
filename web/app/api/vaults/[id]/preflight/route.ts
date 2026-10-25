import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { failure, notFound } from "@/lib/stellar/http";
import { preflight, resolveVaultId } from "@/lib/stellar/vaults";

const body = z.object({
  action: z.enum(["deposit", "withdraw"]),
  user: z.string().refine(value => StrKey.isValidContract(value) || StrKey.isValidEd25519PublicKey(value)),
  amount: z.string().regex(/^[1-9]\d{0,30}$/),
});

/**
 * Simulates a deposit or withdrawal before the user signs it, so a refusal
 * shows the vault's typed error (for example `Paused`) instead of a raw code.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/vaults/[id]/preflight">): Promise<Response> {
  try {
    const address = await resolveVaultId((await ctx.params).id);
    if (!address) return notFound();
    const input = body.parse(await request.json());
    const error = await preflight(address, input.action, input.user, BigInt(input.amount));
    return Response.json({ ok: error === null, error });
  } catch (error) {
    return failure(error);
  }
}
