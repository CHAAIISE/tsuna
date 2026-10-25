import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { after, type NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import deployment from "../../../../deployments/cctp.testnet.json" with { type: "json" };
import { runBridge } from "@/lib/cctp/bridge";
import { BRIDGE_AMOUNT } from "@/lib/cctp/config";
import { createJob, getJob, updateJob } from "@/lib/cctp/jobs";

/** Fast CCTP attestations from Sepolia arrive within minutes; the whole run fits this budget. */
export const maxDuration = 300;

interface BridgeSetup {
  sepoliaPrivateKey: string;
  opsSecret: string;
  userSecret: string;
  vault: string;
}

function setup(): BridgeSetup | null {
  const { SEPOLIA_PRIVATE_KEY, LEASH_CCTP_OPS_SECRET, LEASH_BRIDGE_USER_SECRET, LEASH_BRIDGE_VAULT } = process.env;
  const vault = LEASH_BRIDGE_VAULT ?? deployment.vault;
  if (!SEPOLIA_PRIVATE_KEY || !LEASH_CCTP_OPS_SECRET || !LEASH_BRIDGE_USER_SECRET || !StrKey.isValidContract(vault)) return null;
  return { sepoliaPrivateKey: SEPOLIA_PRIVATE_KEY, opsSecret: LEASH_CCTP_OPS_SECRET, userSecret: LEASH_BRIDGE_USER_SECRET, vault };
}

/** Public facts about the configured bridge; never a secret. */
function describe(config: BridgeSetup | null) {
  if (!config) return { ready: false as const, amount: BRIDGE_AMOUNT.toString() };
  const key = config.sepoliaPrivateKey;
  return {
    ready: true as const,
    amount: BRIDGE_AMOUNT.toString(),
    recipient: Keypair.fromSecret(config.userSecret).publicKey(),
    vault: config.vault,
    sepoliaWallet: privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`).address,
  };
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") ?? undefined;
  return Response.json({ job: await getJob(id), bridge: describe(setup()) });
}

export async function POST() {
  const config = setup();
  if (!config) return Response.json({ error: "The bridge is not configured on this server" }, { status: 503 });
  const facts = describe(config);
  const job = await createJob({ amount: BRIDGE_AMOUNT.toString(), recipient: facts.recipient ?? "", vault: config.vault });
  if (!job) return Response.json({ error: "A bridge is already running", job: await getJob() }, { status: 409 });

  after(async () => {
    try {
      const result = await runBridge({
        sepoliaPrivateKey: config.sepoliaPrivateKey,
        sepoliaRpcUrl: process.env.SEPOLIA_RPC_URL,
        opsSecret: config.opsSecret,
        userSecret: config.userSecret,
        vault: config.vault,
        amount: BRIDGE_AMOUNT,
      }, steps => void updateJob(job.id, { steps }));
      await updateJob(job.id, { status: "done", result });
    } catch (error) {
      await updateJob(job.id, { status: "failed", error: error instanceof Error ? error.message : "Bridge failed" });
    }
  });
  return Response.json({ job }, { status: 202 });
}
