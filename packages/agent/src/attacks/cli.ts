import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatJournalLine } from "../runtime/journal.js";
import { ATTACKS, ATTACK_IDS, runAttack, type AttackId } from "./scenarios.js";

const USAGE = `Usage: attacks [${ATTACK_IDS.join(" | ")} ...]

Runs each attack (all by default) against its demo vault on testnet and prints
BLOCKED <error> <hash> when the vault refused it with the expected error.
Env: LEASH_AGENT_SECRET (session key), LEASH_ATTACKER_SECRET, OPENAI_API_KEY, OPENAI_MODEL.`;

const envFile = fileURLToPath(new URL("../../../../.env.local", import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const unknown = positionals.filter(id => !ATTACK_IDS.includes(id as AttackId));
  if (unknown.length) throw new Error(`Unknown attack ${unknown.join(", ")}\n\n${USAGE}`);
  const ids = positionals.length ? positionals as AttackId[] : [...ATTACK_IDS];
  let failures = 0;
  // Sequential: every attack signs with the same session key.
  for (const id of ids) {
    const attack = ATTACKS[id];
    console.log(`\n# ${attack.title} → ${attack.vault}, expecting ${attack.expected}`);
    try {
      const result = await runAttack(id, { onEntry: entry => console.log(`  ${formatJournalLine(entry)}`) });
      console.log(`  ${result.origin === "model" ? "chosen by the model" : "sent by the attacker"}: ${result.note}`);
      console.log(`  ${result.explorer} (getTransaction: ${result.onChain})`);
      if (result.blocked) {
        console.log(`BLOCKED ${result.error} ${result.hash}`);
      } else {
        failures++;
        console.log(`NOT BLOCKED ${result.status} ${result.error ?? "-"} ${result.hash}`);
      }
    } catch (error) {
      failures++;
      console.log(`NOT BLOCKED ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Attack run failed");
  process.exitCode = 1;
});
