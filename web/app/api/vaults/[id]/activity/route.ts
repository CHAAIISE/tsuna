import { getActivity } from "@/lib/stellar/activity";
import { invalidate } from "@/lib/stellar/client";
import { failure, notFound } from "@/lib/stellar/http";
import { resolveVaultId } from "@/lib/stellar/vaults";

export const dynamic = "force-dynamic";

/** Agent journal, refused attempts, executions and flows of a vault, newest first. */
export async function GET(request: Request, ctx: RouteContext<"/api/vaults/[id]/activity">): Promise<Response> {
  try {
    const address = await resolveVaultId((await ctx.params).id);
    if (!address) return notFound();
    if (new URL(request.url).searchParams.has("fresh")) {
      invalidate(`activity:${address}`);
      invalidate("events");
    }
    return Response.json(await getActivity(address));
  } catch (error) {
    return failure(error);
  }
}
