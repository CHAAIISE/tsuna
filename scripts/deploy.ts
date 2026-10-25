import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { contractExists, ensureAccount, ensureWasm } from "./lib/pay.js";
import {
  address, call, deployContract, fail, read, releaseWasm, send, sendCosigned, signer, simulate, symbol, testnet,
  u64, vec,
} from "./lib/stellar.js";
import { readTestnet, writeTestnet, type TestnetDeployment } from "./lib/testnet-deployment.js";

const REFLECTOR = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const CHAINLINK = "CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4";
/** Chainlink Data Feeds BTC/USD, the only feed published on testnet. */
const CHAINLINK_BTC = "01a0b4d920000332000000000000000000000000000000000000000000000000";
const WBTC = "CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI";
/** Demo timelocks: loosening a policy or upgrading the fleet waits 10 minutes. */
const POLICY_TIMELOCK = 600;
const FACTORY_TIMELOCK = 600;
const VAULT_TAG = "vault-v1";
const DEMO_DIR = fileURLToPath(new URL("../contracts/target/demo", import.meta.url));

const admin = signer("LEASH_ADMIN_SECRET");
const keeper = signer("LEASH_KEEPER_SECRET");
const agent = signer("LEASH_AGENT_SECRET");
const fresh = process.argv.includes("--fresh");

/** `Option<Feed>` as stored by the router: Reflector symbol plus optional Chainlink feed ID. */
function feed(reflectorSymbol: string, chainlink?: string): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: symbol("chainlink"),
      val: chainlink ? xdr.ScVal.scvBytes(Buffer.from(chainlink, "hex")) : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({ key: symbol("reflector"), val: vec([symbol("Other"), symbol(reflectorSymbol)]) }),
  ]);
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A recorded contract is reused while it exists and runs the local build, unless `--fresh`. */
async function reusable(id: string | undefined, recorded: string | undefined, built: string): Promise<string | undefined> {
  return !fresh && id && recorded === built && await contractExists(id) ? id : undefined;
}

async function main(): Promise<void> {
  await Promise.all([ensureAccount(admin), ensureAccount(keeper)]);
  execFileSync("stellar", [
    "contract", "build", "--manifest-path", "contracts/Cargo.toml",
    "--package", "oracle-router", "--features", "demo", "--out-dir", DEMO_DIR,
  ], { stdio: "inherit" });
  // Rebuilt last so the release directory keeps the production router.
  execFileSync("stellar", ["contract", "build", "--manifest-path", "contracts/Cargo.toml"], { stdio: "inherit" });

  const previous = readTestnet();
  const pay = JSON.parse(readFileSync(new URL("../deployments/pay.testnet.json", import.meta.url), "utf8")) as { signalBudget: string };
  const record: TestnetDeployment = {
    ...previous,
    admin: admin.publicKey(),
    agent: agent.publicKey(),
    keeper: keeper.publicKey(),
    signalBudget: pay.signalBudget,
    timelocks: { policySecs: POLICY_TIMELOCK, factorySecs: FACTORY_TIMELOCK },
    wasm: { ...previous.wasm },
    transactions: { ...previous.transactions },
    protocols: { ...previous.protocols, reflector: REFLECTOR, chainlink: CHAINLINK },
  };
  const wasm = record.wasm ?? {};
  const transactions = record.transactions ?? {};
  // Each contract is recorded as soon as it exists, so a failed run resumes where it stopped.
  const save = () => writeTestnet(record);

  // The first router was a production build; demo builds are recorded with their hash.
  if (previous.oracleRouter && !previous.wasm?.oracleRouterDemo) record.oracleRouterStrict ??= previous.oracleRouter;
  const demoWasm = `${DEMO_DIR}/oracle_router.wasm`;
  let router = await reusable(previous.oracleRouter, previous.wasm?.oracleRouterDemo, sha256(demoWasm));
  if (!router) {
    const deployed = await deployContract(admin, "oracle_router", [
      address(admin.publicKey()), address(testnet.usdc), address(REFLECTOR), address(CHAINLINK),
    ], demoWasm);
    router = deployed.id;
    wasm.oracleRouterDemo = deployed.wasmHash;
    transactions.oracleRouterDeploy = deployed.txHash;
    console.log(`ORACLE_ROUTER ${router} ${deployed.txHash}`);
  }
  record.oracleRouter = router;
  save();
  for (const [name, asset, expected] of [
    ["USDC", testnet.usdc, feed("USDC")],
    ["XLM", testnet.xlm, feed("XLM")],
    ["wBTC", WBTC, feed("BTC", CHAINLINK_BTC)],
  ] as const) {
    const { simulation } = await simulate(admin, call(router, "feed", [address(asset)]));
    if (simulation.result?.retval.toXDR("base64") === expected.toXDR("base64")) continue;
    const set = await send(admin, call(router, "set_feed", [address(asset), expected]));
    transactions[`oracleFeed${name}`] = set.txHash;
    console.log(`ORACLE_FEED ${name} ${set.txHash}`);
  }
  // Demo mode lets the admin force prices for the crash scenario; `is_demo()` makes it public.
  if (!await read<boolean>(admin, router, "is_demo")) {
    const enabled = await send(admin, call(router, "set_demo", [xdr.ScVal.scvBool(true)]));
    transactions.oracleDemoMode = enabled.txHash;
    console.log(`ORACLE_DEMO_MODE ${enabled.txHash}`);
  }
  save();
  console.log(`ORACLE_PRICES xlm=${await read<bigint>(admin, router, "price_strict", [address(testnet.xlm)])} wbtc=${await read<bigint>(admin, router, "price_strict", [address(WBTC)])}`);

  let registry = await reusable(previous.policyRegistry, previous.wasm?.policyRegistry, sha256(releaseWasm("policy_registry")));
  if (!registry) {
    const deployed = await deployContract(admin, "policy_registry", [u64(BigInt(POLICY_TIMELOCK))]);
    registry = deployed.id;
    wasm.policyRegistry = deployed.wasmHash;
    transactions.policyRegistryDeploy = deployed.txHash;
    console.log(`POLICY_REGISTRY ${registry} ${deployed.txHash}`);
  }
  record.policyRegistry = registry;
  save();

  const built = (await ensureWasm(admin, releaseWasm("agent_vault"))).toString("hex");
  const tag = nativeToScVal(VAULT_TAG, { type: "string" });
  const servedBy = async (id: string) => {
    const served = await read<Uint8Array | null>(admin, id, "current_ref", [tag]);
    return served ? Buffer.from(served).toString("hex") : undefined;
  };
  let factory = await reusable(previous.factory, previous.wasm?.vaultFactory, sha256(releaseWasm("vault_factory")));
  // A factory still serving an older vault build gets upgraded through propose_ref/apply_ref
  // (timelocked); the deploy script starts a fleet on the local build instead.
  const served = factory && await servedBy(factory);
  if (factory && served && served !== built) {
    console.log(`VAULT_FACTORY ${factory} serves agent_vault ${served}; deploying a factory for ${built}`);
    factory = undefined;
  }
  if (!factory) {
    const deployed = await deployContract(admin, "vault_factory", [
      address(admin.publicKey()), address(keeper.publicKey()), u64(BigInt(FACTORY_TIMELOCK)),
    ]);
    factory = deployed.id;
    wasm.vaultFactory = deployed.wasmHash;
    transactions.factoryDeploy = deployed.txHash;
    delete transactions.factorySetRef;
    console.log(`VAULT_FACTORY ${factory} ${deployed.txHash}`);
  }
  record.factory = factory;
  save();
  if (!await servedBy(factory)) {
    const set = await sendCosigned(admin, call(factory, "set_ref", [tag, xdr.ScVal.scvBytes(Buffer.from(built, "hex"))]), [keeper]);
    transactions.factorySetRef = set.txHash;
    console.log(`VAULT_REF ${VAULT_TAG} ${built} ${set.txHash}`);
  }
  wasm.agentVault = built;
  record.vaultRef = built;
  // Vaults belong to one factory, registry and router; a new one starts an empty fleet.
  const sameFleet = previous.factory === factory && previous.policyRegistry === registry && previous.oracleRouter === router;
  if (!sameFleet) record.vaults = [];
  save();
  console.log(`DEPLOYED router=${router} registry=${registry} factory=${factory} signalBudget=${pay.signalBudget}`);
}

main().catch(fail);
