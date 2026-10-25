import { failure } from "@/lib/stellar/http";
import { listAgents } from "@/lib/stellar/vaults";

export const dynamic = "force-dynamic";

/** Every factory vault with NAV, policy summary and leaderboard scores, read on-chain. */
export async function GET(): Promise<Response> {
  try {
    return Response.json(await listAgents());
  } catch (error) {
    return failure(error);
  }
}
