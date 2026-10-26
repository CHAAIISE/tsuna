import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { Tsuna } from "@tsuna/sdk";
import { runKeeper } from "./keeper.js";

const envFile = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (existsSync(envFile)) loadEnvFile(envFile);

async function main(): Promise<void> {
  const secret = process.env.LEASH_KEEPER_SECRET;
  if (!secret) throw new Error("LEASH_KEEPER_SECRET is not set");
  const vaults = process.argv.slice(2);
  const report = await runKeeper({
    tsuna: new Tsuna(),
    keeper: Keypair.fromSecret(secret),
    ...(vaults.length > 0 ? { vaults } : {}),
    onEntry: entry => console.log(JSON.stringify(entry)),
  });
  const errors = report.entries.filter(entry => entry.kind === "error").length;
  console.log(`\nKEEPER vaults=${new Set(report.entries.map(e => e.vault)).size} upgrades=${report.upgrades.length} errors=${errors}`);
  if (errors > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
