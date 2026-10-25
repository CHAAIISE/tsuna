import { appendFileSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Address, Keypair, Operation, StrKey } from "@stellar/stellar-sdk";
import { UNIT, fail, send, simulate, testnet } from "./lib/stellar.js";
import { ensureAccount, topUpXlm } from "./lib/friendbot.js";
import { recordPasskeyDeployment } from "./lib/passkey-deployment.js";

const root = new URL("../", import.meta.url);
const wasmDir = new URL("contracts/target/wasm32v1-none/release/", root);
/** XLM kept on the relayer for sponsored deployments and user operations. */
const RELAYER_FLOAT = 5_000n * UNIT;

/** Returns the relayer key, creating and saving one on first run. */
function relayerKey(): Keypair {
  const secret = process.env.LEASH_RELAYER_SECRET;
  if (secret) return Keypair.fromSecret(secret);
  const key = Keypair.random();
  appendFileSync(fileURLToPath(new URL(".env.local", root)), `\nLEASH_RELAYER_SECRET=${key.secret()}\n`);
  console.log(`RELAYER_CREATED ${key.publicKey()}`);
  return key;
}

async function upload(relayer: Keypair, file: string): Promise<{ hash: string; tx: string }> {
  const wasm = readFileSync(new URL(file, wasmDir));
  const hash = createHash("sha256").update(wasm).digest("hex");
  const operation = Operation.uploadContractWasm({ wasm });
  // Storage fees on testnet can reach thousands of XLM: fund the upload up front.
  const { simulation } = await simulate(relayer, operation);
  const fee = BigInt(simulation.minResourceFee);
  await topUpXlm(relayer, fee + RELAYER_FLOAT);
  const result = await send(relayer, operation);
  console.log(`UPLOAD ${file} ${hash} ${result.txHash} fee=${fee / UNIT} XLM`);
  return { hash, tx: result.txHash };
}

async function main(): Promise<void> {
  const relayer = relayerKey();
  await ensureAccount(relayer);
  const verifierWasm = await upload(relayer, "passkey_webauthn_verifier.wasm");
  const deploy = Operation.createCustomContract({
    address: Address.fromString(relayer.publicKey()),
    wasmHash: Buffer.from(verifierWasm.hash, "hex"),
    salt: randomBytes(32),
  });
  const deployed = await send(relayer, deploy);
  const retval = deployed.returnValue;
  if (!retval) throw new Error("Verifier deployment returned no address");
  const verifier = Address.fromScVal(retval).toString();
  if (!StrKey.isValidContract(verifier)) throw new Error(`Unexpected verifier address ${verifier}`);
  console.log(`DEPLOY_VERIFIER ${verifier} ${deployed.txHash}`);

  const accountWasm = await upload(relayer, "passkey_account.wasm");
  await topUpXlm(relayer, RELAYER_FLOAT * 2n);

  recordPasskeyDeployment({
    network: "testnet",
    relayer: relayer.publicKey(),
    usdc: testnet.usdc,
    verifier,
    verifierWasmHash: verifierWasm.hash,
    accountWasmHash: accountWasm.hash,
  }, {
    verifierUpload: verifierWasm.tx,
    verifierDeploy: deployed.txHash,
    accountUpload: accountWasm.tx,
  });
}

main().catch(fail);
