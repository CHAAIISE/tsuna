import { StrKey } from "@stellar/stellar-sdk";
import { invalidate } from "@/lib/stellar/client";
import { failure } from "@/lib/stellar/http";
import { getHoldings } from "@/lib/stellar/vaults";

export const dynamic = "force-dynamic";

/** Shares, value and net deposits of `?user=` in every vault, plus their USDC balance. */
export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const user = params.get("user") ?? "";
    if (!StrKey.isValidContract(user) && !StrKey.isValidEd25519PublicKey(user)) {
      return Response.json({ error: "Expected a Stellar address." }, { status: 400 });
    }
    if (params.has("fresh")) {
      invalidate(`holdings:${user}`);
      invalidate("events");
      invalidate("agents");
    }
    return Response.json(await getHoldings(user));
  } catch (error) {
    return failure(error);
  }
}
