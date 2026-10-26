import { after } from "next/server";
import { ATTACKS, ATTACK_IDS, executableHash } from "@tsuna/agent";
import { Contract, StrKey, rpc } from "@stellar/stellar-sdk";
import { z } from "zod";
import { attackRuns, prepareAttack } from "@/lib/stellar/attack-runs";
import { tsuna } from "@/lib/stellar/client";
import { contractName } from "@/lib/stellar/deployments";
import { ApiError, failure, notFound } from "@/lib/stellar/http";
import { resolveVaultId } from "@/lib/stellar/vaults";
import { clientIp, rateLimit } from "@/lib/sponsor/rate-limit";
import { tooManyRequests } from "@/lib/sponsor/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("launch"), attack: z.enum(ATTACK_IDS) }),
  z.object({ action: z.literal("prepare-revoke"), vault: z.string().min(1).max(64), account: z.string().refine(StrKey.isValidEd25519PublicKey) }),
]);

export async function GET(request: Request): Promise<Response> {
  try {
    const watch = new URL(request.url).searchParams.get("watch");
    if (watch) {
      const address = await resolveVaultId(watch);
      if (!address) return notFound();
      const client = tsuna();
      const vault = client.vault(address);
      const [policy, halted] = await Promise.all([vault.policy(), vault.haltedProtocols()]);
      const protocols = await Promise.all(policy.protocols.map(async protocol => {
        const [pinned, current] = await Promise.all([vault.protocolHash(protocol), executableHash(client.server, protocol)]);
        return { protocol, name: contractName(protocol), pinned, current, halted: halted.includes(protocol) };
      }));
      return Response.json({ protocols, asOf: new Date().toISOString() });
    }
    return Response.json({ attacks: Object.values(ATTACKS), runs: attackRuns() });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = body.parse(await request.json());
    const wait = rateLimit(`attack:${clientIp(request)}`, 30, 60 * 60 * 1000);
    if (wait) return tooManyRequests(wait);
    if (input.action === "prepare-revoke") {
      const address = await resolveVaultId(input.vault);
      if (!address) return notFound();
      const client = tsuna();
      if (await client.vault(address).owner() !== input.account) throw new ApiError("Connect the wallet that created this vault.", 403);
      const { tx, simulation } = await client.chain.simulate(input.account, new Contract(address).call("revoke_session"), "vault");
      return Response.json({ xdr: rpc.assembleTransaction(tx, simulation).build().toXDR() });
    }
    const prepared = await prepareAttack(input.attack);
    after(prepared.task);
    return Response.json({ run: prepared.run }, { status: 202 });
  } catch (error) { return failure(error); }
}
