import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = new URL("../../deployments/passkey.testnet.json", import.meta.url);

/**
 * Merges addresses and transaction hashes into
 * `deployments/passkey.testnet.json`, keeping what other scripts recorded.
 */
export function recordPasskeyDeployment(fields: Record<string, string>, transactions: Record<string, string> = {}): void {
  type DeploymentRecord = Record<string, unknown> & { transactions?: Record<string, string> };
  const current: DeploymentRecord = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as DeploymentRecord : { network: "testnet" };
  mkdirSync(new URL(".", file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    ...current,
    ...fields,
    transactions: { ...current.transactions, ...transactions },
  }, null, 2)}\n`);
  console.log(`WROTE ${fileURLToPath(file)}`);
}
