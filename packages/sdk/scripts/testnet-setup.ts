/**
 * Prepares the SDK's own testnet fixtures, idempotently:
 * - burner keys `LEASH_SDKTEST_{OWNER,AGENT,RISKOFF}_SECRET`, created with Friendbot and
 *   appended to the repository's `.env.local` (values are never printed);
 * - test USDC for the owner, borrowed from the Blend testnet pool against XLM collateral;
 * - a vault deployed through the factory with a policy composed from presets (`sdk-smoke`),
 *   and a vault left without policy (`sdk-probe`) to simulate `register` of any policy;
 * - `deployments/sdk.testnet.json` recording them with the infrastructure they use.
 *
 * Infrastructure addresses come from the deployments file (`LEASH_DEPLOYMENTS` or
 * `deployments/testnet.json`). Run: `pnpm --filter @leash/sdk testnet:setup`.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, loadEnvFile, stdout } from "node:process";
import {
  Asset, Contract, Keypair, Operation, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import {
  BlendRequest, Leash, TESTNET, blendRequestVal, composePolicy, loadDeployments,
  type Deployments, type Venues, type VaultRecord,
} from "../src/index.js";

const root = new URL("../../../", import.meta.url).pathname;
const envFile = join(root, ".env.local");
const output = join(root, "deployments", "sdk.testnet.json");
const UNIT = 10_000_000n;
/** Owner's USDC stock for deposits; borrowed once against ten times its value in XLM. */
const USDC_STOCK = 50n * UNIT;
const XLM_COLLATERAL = 3_000n * UNIT;

const log = (line: string) => stdout.write(`${line}\n`);

if (existsSync(envFile)) loadEnvFile(envFile);
const infra = loadDeployments();
const leash = new Leash({ deployments: infra });
const { server, chain } = leash;

async function funded(name: string): Promise<Keypair> {
  const existing = env[name];
  if (existing) return Keypair.fromSecret(existing);
  const key = Keypair.random();
  await server.fundAddress(key.publicKey());
  appendFileSync(envFile, `${name}=${key.secret()}\n`, { mode: 0o600 });
  env[name] = key.secret();
  log(`KEY ${name} ${key.publicKey()} (funded by Friendbot, secret appended to .env.local)`);
  return key;
}

/** USDC balance of `owner`, `null` while the account has no USDC trustline (the SAC then fails). */
async function usdcBalance(owner: string): Promise<bigint | null> {
  return leash.read<bigint>(TESTNET.usdc, "balance", [nativeToScVal(owner, { type: "address" })]).catch(() => null);
}

async function ensureUsdc(owner: Keypair): Promise<void> {
  let held = await usdcBalance(owner.publicKey());
  if (held === null) {
    const tx = new TransactionBuilder(await server.getAccount(owner.publicKey()), {
      fee: "10000", networkPassphrase: TESTNET.networkPassphrase,
    }).addOperation(Operation.changeTrust({ asset: new Asset("USDC", TESTNET.usdcIssuer) })).setTimeout(120).build();
    log(`TRUST_USDC ${(await chain.submit(owner, tx)).hash}`);
    held = 0n;
  }
  if (held >= USDC_STOCK / 2n) {
    log(`USDC_STOCK ${held}`);
    return;
  }
  const submit = (asset: string, amount: bigint, type: (typeof BlendRequest)[keyof typeof BlendRequest]) =>
    chain.invoke(owner, new Contract(TESTNET.blendPool).call("submit",
      ...[owner, owner, owner].map(k => nativeToScVal(k.publicKey(), { type: "address" })),
      nativeToScVal([blendRequestVal(asset, amount, type)])), [owner]);
  log(`BLEND_COLLATERAL ${(await submit(TESTNET.xlm, XLM_COLLATERAL, BlendRequest.SupplyCollateral)).hash}`);
  log(`BLEND_BORROW ${(await submit(TESTNET.usdc, USDC_STOCK - held, BlendRequest.Borrow)).hash}`);
  log(`USDC_STOCK ${await usdcBalance(owner.publicKey())}`);
}

async function exists(contract: string): Promise<boolean> {
  return server.getContractData(contract, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent)
    .then(() => true, () => false);
}

async function main(): Promise<void> {
  const owner = await funded("LEASH_SDKTEST_OWNER_SECRET");
  const agent = await funded("LEASH_SDKTEST_AGENT_SECRET");
  const riskOff = await funded("LEASH_SDKTEST_RISKOFF_SECRET");
  await ensureUsdc(owner);

  const previous: Deployments | null = existsSync(output) ? loadDeployments(output) : null;
  const protocols = infra.protocols ?? {};
  const venues: Venues = {
    blendPool: protocols.blendPool ?? TESTNET.blendPool,
    soroswapRouter: protocols.soroswapRouter ?? TESTNET.soroswapRouter,
    ...(protocols.defindexVault ? { defindexVault: protocols.defindexVault } : {}),
    defindexCustody: [protocols.defindexBlendUsdcStrategy ?? TESTNET.defindexBlendUsdcStrategy, protocols.blendPool ?? TESTNET.blendPool],
    ...(protocols.soroswapPairXlmUsdc ? { soroswapPairs: [protocols.soroswapPairXlmUsdc] } : {}),
  };
  const vaults: VaultRecord[] = [];

  let smoke = previous?.vaults.find(v => v.id === "sdk-smoke");
  if (!smoke || !await exists(smoke.address)) {
    const policy = composePolicy({
      assets: [TESTNET.usdc, TESTNET.xlm],
      venues,
      actions: ["blend.supply", "blend.withdraw", "defindex.deposit", "defindex.withdraw", "soroswap.swap"],
      riskOffMember: riskOff.publicKey(),
    });
    const adapters = [
      { kind: "Blend" as const, protocol: venues.blendPool as string },
      ...(venues.defindexVault ? [{ kind: "DeFindex" as const, protocol: venues.defindexVault }] : []),
      { kind: "Soroswap" as const, protocol: venues.soroswapRouter as string },
    ];
    const created = await leash.createVault(owner, { agent: agent.publicKey(), policy, adapters });
    log(`VAULT sdk-smoke ${created.address} deploy=${created.deployTx} register=${created.registerTx} adapters=${created.adapterTxs.join(",")}`);
    smoke = {
      id: "sdk-smoke", name: "SDK smoke", address: created.address, owner: owner.publicKey(), agent: agent.publicKey(),
      roles: ["default", "riskoff"], assets: policy.assets, adapters,
      deployTx: created.deployTx, registerTx: created.registerTx, adapterTxs: created.adapterTxs,
    };
  }
  vaults.push(smoke);

  let probe = previous?.vaults.find(v => v.id === "sdk-probe");
  if (!probe || !await exists(probe.address)) {
    const deployed = await leash.deployVault(owner, { agent: agent.publicKey(), asset: TESTNET.usdc });
    log(`VAULT sdk-probe ${deployed.address} deploy=${deployed.hash} (no policy, used to simulate register)`);
    probe = { id: "sdk-probe", name: "SDK probe (no policy)", address: deployed.address, owner: owner.publicKey(), deployTx: deployed.hash };
  }
  vaults.push(probe);

  const record = {
    network: infra.network,
    factory: infra.factory,
    policyRegistry: infra.policyRegistry,
    oracleRouter: infra.oracleRouter,
    keeper: infra.keeper,
    protocols: infra.protocols,
    vaults,
  };
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  log(`WROTE ${output}`);
  const nav = scValToNative(await chain.read(owner.publicKey(), new Contract(smoke.address).call("nav")));
  log(`CHECK sdk-smoke nav=${String(nav)}`);
  if (!readFileSync(output, "utf8").includes(smoke.address)) throw new Error("Deployments file not written");
}

main().catch((error: unknown) => {
  // Never dump SDK errors wholesale: they can embed signed envelopes.
  log(error instanceof Error ? error.message : "Testnet setup failed");
  process.exitCode = 1;
});
