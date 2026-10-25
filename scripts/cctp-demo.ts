import { parseArgs } from "node:util";
import { BRIDGE_AMOUNT } from "../web/lib/cctp/config.js";
import { runBridge, type BridgeStep } from "../web/lib/cctp/bridge.js";
import { formatUsdc } from "../web/lib/cctp/format.js";
import { sepoliaClients, sepoliaUsdcBalance } from "../web/lib/cctp/sepolia.js";
import { UNIT, fail, signer } from "./lib/stellar.js";
import { VAULT_WASM_HASH, ensureDemoUser, ensurePool, ensureVault, readDeployment, writeDeployment } from "./lib/cctp-setup.js";

/** Pool depth per side: a 1 USDC swap then loses ~0.4 %, inside the 0.5 % floor. */
const POOL_DEPTH = 1_000n * UNIT;
/** Blend USDC kept by the ops account to swap the pair back to 1:1 after bridged swaps. */
const PEG_BUFFER = 20n * UNIT;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { resume: { type: "string" } } });
  const sepoliaKey = process.env.SEPOLIA_PRIVATE_KEY;
  if (!sepoliaKey) throw new Error("Missing SEPOLIA_PRIVATE_KEY");
  const ops = signer("LEASH_CCTP_OPS_SECRET");
  const user = await ensureDemoUser();
  console.log(`OPS ${ops.publicKey()}`);
  console.log(`RECIPIENT ${user.publicKey()}`);

  const { vault, deployTx } = await ensureVault(ops);
  const record = (soroswapPair: string) => {
    if (process.env.LEASH_BRIDGE_VAULT || !deployTx) return;
    writeDeployment({
      network: "testnet",
      vault,
      vaultWasmHash: VAULT_WASM_HASH,
      vaultDeployTx: deployTx,
      vaultOwner: ops.publicKey(),
      soroswapPair,
      bridgeUser: user.publicKey(),
    });
  };
  // Record the vault before the pool work so a failed run reuses it.
  record(readDeployment()?.soroswapPair ?? "");
  record(await ensurePool(ops, POOL_DEPTH, PEG_BUFFER));
  console.log(`VAULT ${vault}${readDeployment()?.vault === vault ? " (deployments/cctp.testnet.json)" : ""}`);

  const sepolia = sepoliaClients(sepoliaKey, process.env.SEPOLIA_RPC_URL);
  console.log(`SEPOLIA_WALLET ${sepolia.account.address} ${formatUsdc(await sepoliaUsdcBalance(sepolia), 6)} USDC`);

  const printed = new Set<string>();
  const report = (steps: BridgeStep[]) => {
    for (const step of steps) {
      const line = `[${step.id}] ${step.status}${step.detail ? `: ${step.detail}` : ""}`;
      if (!printed.has(line)) console.log(line);
      printed.add(line);
      for (const tx of step.txs) {
        const key = `${tx.network}:${tx.hash}`;
        if (!printed.has(key)) console.log(`${tx.network === "sepolia" ? "SEPOLIA" : "STELLAR"} ${tx.label} ${tx.hash}`);
        printed.add(key);
      }
    }
  };
  const result = await runBridge({
    sepoliaPrivateKey: sepoliaKey,
    sepoliaRpcUrl: process.env.SEPOLIA_RPC_URL,
    opsSecret: ops.secret(),
    userSecret: user.secret(),
    vault,
    amount: BRIDGE_AMOUNT,
    ...(values.resume ? { burnTxHash: values.resume } : {}),
  }, report);

  console.log(`MINTED ${formatUsdc(BigInt(result.minted), 7)} Circle USDC`);
  console.log(`DEPOSITED ${formatUsdc(BigInt(result.deposited), 7)} Blend USDC`);
  console.log(`SHARES ${result.shares}`);
  console.log(`SEPOLIA_USDC_REMAINING ${formatUsdc(await sepoliaUsdcBalance(sepolia), 6)}`);
  if (BigInt(result.shares) <= 0n) throw new Error("No shares received");
}

main().catch(fail);
