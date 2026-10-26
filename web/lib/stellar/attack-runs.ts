import "server-only";
import { randomUUID } from "node:crypto";
import { ATTACKS, runAttack, type AttackId } from "@tsuna/agent";
import { Keypair } from "@stellar/stellar-sdk";
import { invalidate, tsuna } from "./client";
import { fleet } from "./deployments";
import { ApiError } from "./http";
import { reserveSource } from "./source-lock";
import type { AttackRun } from "./attack-types";

const runs = new Map<string, AttackRun>();
export const attackRuns = () => [...runs.values()];

export async function prepareAttack(id: AttackId): Promise<{ run: AttackRun; task: () => Promise<void> }> {
  const session = process.env.LEASH_AGENT_SECRET;
  const attacker = process.env.LEASH_ATTACKER_SECRET;
  if (!session || !attacker || (id === "injection" && !process.env.OPENAI_API_KEY)) {
    throw new ApiError("The demo attack keys or model are not configured on this server.", 503);
  }
  const member = Keypair.fromSecret(session);
  const release = reserveSource(member.publicKey());
  try {
    const record = fleet.vaults.find(vault => vault.id === ATTACKS[id].vault);
    if (!record) throw new ApiError("The attack's demo vault is not deployed.", 404);
    const vault = tsuna().vault(record.address);
    if (await vault.session() !== member.publicKey()) throw new ApiError("This session is revoked or rotated. The creator must restore it before replaying attacks.", 409);
    if (await vault.paused()) throw new ApiError("This demo vault is paused. Restore the crash scenario before launching attacks.", 409);
    const run: AttackRun = { id: randomUUID(), attack: id, status: "running", result: null, error: null };
    runs.set(id, run);
    return {
      run,
      task: async () => {
        try {
          run.result = await runAttack(id, { deployments: fleet, tsuna: tsuna(), sessionKey: member, attacker: Keypair.fromSecret(attacker) });
          run.status = "finished";
        } catch (error) {
          console.error(error instanceof Error ? error.message : "Attack failed");
          run.status = "failed";
          run.error = "The attack could not be completed. Check the vault's session and pause state, then try again.";
        } finally {
          release();
          invalidate(`vault:${record.address}`);
          invalidate(`activity:${record.address}`);
          invalidate("agents");
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
