import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { formatJournalLine } from "./runtime/journal.js";
import { loadNewsPage } from "./runtime/news.js";
import { runAgent, signalOptions } from "./runtime/run.js";
import { STRATEGY_IDS, type StrategyId } from "./runtime/strategies.js";

const USAGE = `Usage: agent run <vault|prudent|leverage|liquidity> [--role riskoff] [--strategy <id>] [--inject <file|url>] [--news <file|url>]

  --role       vault role to act under (riskoff runs the risk-off strategy)
  --strategy   ${STRATEGY_IDS.join(" | ")} (default: the vault's own)
  --inject     poisoned page returned by fetch_market_news
  --news       page returned by fetch_market_news
Env: OPENAI_API_KEY, OPENAI_MODEL; LEASH_SIGNALS_URL enables buy_signal (session key LEASH_AGENT_SECRET).`;

const envFile = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      role: { type: "string" },
      strategy: { type: "string" },
      inject: { type: "string" },
      news: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, vault] = positionals;
  if (values.help || command !== "run" || !vault) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const strategy = STRATEGY_IDS.find(id => id === values.strategy);
  if (values.strategy && !strategy) throw new Error(`Unknown strategy ${values.strategy}`);
  const signalsUrl = process.env.LEASH_SIGNALS_URL;
  const sessionSecret = process.env.LEASH_AGENT_SECRET;
  const result = await runAgent({
    vault,
    ...(strategy ? { strategy: strategy as StrategyId } : {}),
    ...(values.role ? { role: values.role } : {}),
    ...(values.inject ? { injection: await loadNewsPage(values.inject) } : {}),
    ...(values.news ? { news: values.news } : {}),
    ...(signalsUrl && sessionSecret ? { signals: signalOptions(signalsUrl, Keypair.fromSecret(sessionSecret)) } : {}),
    onEntry: entry => console.log(formatJournalLine(entry)),
  });
  console.log(`\nRUN ${result.vault.name} ${result.vault.address} strategy=${result.strategy} role=${result.role} model=${result.model} steps=${result.steps}`);
  for (const tx of result.transactions) {
    console.log(`TX ${tx.status} ${tx.hash}${tx.error ? ` ${tx.error}` : ""} https://stellar.expert/explorer/testnet/tx/${tx.hash}`);
  }
  if (result.transactions.length === 0) console.log("TX none");
  console.log(`\n${result.text}`);
}

main().catch((error: unknown) => {
  // SDK errors can carry signed envelopes: print the message only.
  console.error(error instanceof Error ? error.message : "Agent run failed");
  process.exitCode = 1;
});
