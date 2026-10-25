import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import { UNIT, address, balance, fail, i128, signer, testnet, u32 } from "./lib/stellar.js";
import { contractExists, deployContract, ensureAccount, ensureBlendUsdc, ensureWasm, transferUsdc } from "./lib/pay.js";

export const DEPLOYMENT_FILE = "deployments/pay.testnet.json";
const RELEASE = "contracts/target/wasm32v1-none/release";
const SPENDING_LIMIT = 5n * UNIT;
const PERIOD_LEDGERS = 17_280;
/** The budget is refilled to this balance when it drops below half of it. */
const BUDGET_FUNDING = 20n * UNIT;

export interface PayDeployment {
  network: "testnet";
  usdc: string;
  admin: string;
  /** Agent account whose ed25519 key is the session signer. */
  agent: string;
  payTo: string;
  facilitator: string;
  spendingLimit: string;
  periodLedgers: number;
  wasm: { signalBudget: string; verifier: string; policy: string };
  verifier: string;
  policy: string;
  signalBudget: string;
}

export async function readDeployment(): Promise<PayDeployment | undefined> {
  try {
    return JSON.parse(await readFile(DEPLOYMENT_FILE, "utf8")) as PayDeployment;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Deploys (or reuses) the shared verifier and policy and a signal budget whose
 * session key is the agent key, then keeps the budget funded with Blend USDC.
 * `fresh` forces a new budget account, which starts with an empty spending window.
 */
export async function deploySignalBudget({ fresh = false } = {}): Promise<PayDeployment> {
  const ops = signer("LEASH_PAY_OPS_SECRET");
  const facilitator = signer("LEASH_FACILITATOR_SECRET");
  // The agent key only ever signs authorization entries for the budget.
  const agent = signer("LEASH_AGENT_SECRET").publicKey();
  await Promise.all([ensureAccount(ops), ensureAccount(facilitator)]);
  execFileSync("stellar", ["contract", "build", "--manifest-path", "contracts/Cargo.toml"], { stdio: "inherit" });

  const previous = await readDeployment();
  const wasm = {
    signalBudget: (await ensureWasm(ops, `${RELEASE}/signal_budget.wasm`)).toString("hex"),
    verifier: (await ensureWasm(ops, `${RELEASE}/signal_budget_ed25519_verifier.wasm`)).toString("hex"),
    policy: (await ensureWasm(ops, `${RELEASE}/signal_budget_spending_limit_policy.wasm`)).toString("hex"),
  };
  const reuse = async (id: string | undefined, hash: string, recorded: string | undefined) =>
    id && hash === recorded && await contractExists(id) ? id : undefined;

  const verifier = await reuse(previous?.verifier, wasm.verifier, previous?.wasm.verifier)
    ?? await deployContract(ops, Buffer.from(wasm.verifier, "hex"));
  const policy = await reuse(previous?.policy, wasm.policy, previous?.wasm.policy)
    ?? await deployContract(ops, Buffer.from(wasm.policy, "hex"));
  const sameBudget = !fresh && previous?.verifier === verifier && previous.policy === policy
    && previous.agent === agent && previous.admin === ops.publicKey();
  const signalBudget = (sameBudget ? await reuse(previous.signalBudget, wasm.signalBudget, previous.wasm.signalBudget) : undefined)
    ?? await deployContract(ops, Buffer.from(wasm.signalBudget, "hex"), [
      address(ops.publicKey()),
      xdr.ScVal.scvBytes(StrKey.decodeEd25519PublicKey(agent)),
      address(testnet.usdc),
      i128(SPENDING_LIMIT),
      u32(PERIOD_LEDGERS),
      address(verifier),
      address(policy),
    ]);

  const funded = await balance(ops, signalBudget);
  if (funded < BUDGET_FUNDING / 2n) {
    await ensureBlendUsdc(ops, BUDGET_FUNDING - funded);
    const transfer = await transferUsdc(ops, signalBudget, BUDGET_FUNDING - funded);
    console.log(`FUND_BUDGET ${signalBudget} ${transfer.txHash}`);
  }

  const deployment: PayDeployment = {
    network: "testnet",
    usdc: testnet.usdc,
    admin: ops.publicKey(),
    agent,
    payTo: ops.publicKey(),
    facilitator: facilitator.publicKey(),
    spendingLimit: SPENDING_LIMIT.toString(),
    periodLedgers: PERIOD_LEDGERS,
    wasm,
    verifier,
    policy,
    signalBudget,
  };
  await mkdir("deployments", { recursive: true });
  await writeFile(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`SIGNAL_BUDGET ${signalBudget} balance=${await balance(ops, signalBudget)}`);
  return deployment;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  deploySignalBudget().catch(fail);
}
