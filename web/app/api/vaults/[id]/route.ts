import { invalidate } from "@/lib/stellar/client";
import { failure, notFound } from "@/lib/stellar/http";
import { getVault, resolveVaultId } from "@/lib/stellar/vaults";

export const dynamic = "force-dynamic";

/** One vault: positions, exposure, policy, roles and their budgets. `?fresh=1` skips the cache. */
export async function GET(request: Request, ctx: RouteContext<"/api/vaults/[id]">): Promise<Response> {
  try {
    const address = await resolveVaultId((await ctx.params).id);
    if (!address) return notFound();
    if (new URL(request.url).searchParams.has("fresh")) invalidate(`vault:${address}`);
    return Response.json(await getVault(address));
  } catch (error) {
    return failure(error);
  }
}
