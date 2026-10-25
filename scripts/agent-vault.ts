/**
 * Deploys a Prudent-style vault through the deployed factory whose session key,
 * risk-off member, owner and fee payer are keys of their own (`LEASH_AGENTRUN_*`),
 * so the agent runtime can be exercised end to end on testnet without sharing
 * the demo session key. Idempotent: every step is recorded in
 * `deployments/agent.testnet.json` and skipped once done.
 *
 * Usage: `pnpm tsx scripts/agent-vault.ts` (reads the fleet addresses from
 * `LEASH_DEPLOYMENTS` or `deployments/testnet.json`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ensureAccount, ensureBlendUsdc } from "./lib/pay.js";
import {
  UNIT, adapterKind, address, call, callRule, defaultLimits, fail, i128, read, send, signer, symbol, testnet, u32, vec,
} from "./lib/stellar.js";

const RECORD = fileURLToPath(new URL("../deployments/agent.testnet.json", import.meta.url));
const FLEET = process.env.LEASH_DEPLOYMENTS ?? fileURLToPath(new URL("../deployments/testnet.json", import.meta.url));
const DEPOSIT = 100n * UNIT;
const STABLE_BPS = 10;
const ENV = {
  owner: "LEASH_AGENTRUN_OWNER_SECRET",
  agent: "LEASH_AGENTRUN_AGENT_SECRET",
  feePayer: "LEASH_AGENTRUN_FEE_SECRET",
  riskoff: "LEASH_AGENTRUN_RISKOFF_SECRET",
} as const;

interface Fleet {
  factory: string;
  policyRegistry: string;
  oracleRouter: string;
  keeper: string;
  protocols: { blendPool: string; defindexVault: string; defindexBlendUsdcStrategy: string };
}

interface AgentVaultRecord {
  id: string;
  name: string;
  slug: string;
  strategy: string;
  strategyId: "prudent";
  address: string;
  factory: string;
  registry: string;
  oracle: string;
  owner: string;
  agent: string;
  assets: string[];
  adapters: { kind: "Blend" | "DeFindex"; protocol: string }[];
  roles: Record<string, { member: string; env: string }>;
  feePayer: { address: string; env: string };
  deployTx: string;
  policyTx?: string;
  adapterTxs: string[];
  depositTx?: string;
  deposit?: string;
}

interface AgentDeployment {
  network: "testnet";
  vaults: AgentVaultRecord[];
}

const fleet = JSON.parse(readFileSync(FLEET, "utf8")) as Fleet;
const record: AgentDeployment = existsSync(RECORD)
  ? JSON.parse(readFileSync(RECORD, "utf8")) as AgentDeployment
  : { network: "testnet", vaults: [] };
const save = () => writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);

const owner = signer(ENV.owner);
const agent = signer(ENV.agent);
const feePayer = signer(ENV.feePayer);
const riskoff = signer(ENV.riskoff);
const { blendPool: pool, defindexVault: defindex, defindexBlendUsdcStrategy: strategy } = fleet.protocols;

const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: symbol(key), val });
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(Object.keys(fields).sort().map(key => field(key, fields[key] as xdr.ScVal)));
const byAddress = (a: string, b: string) =>
  Buffer.compare(new Address(a).toScAddress().toXDR(), new Address(b).toScAddress().toXDR());

type Rule = { target: string; fn: string; rule: xdr.ScVal };
/** `Map<(Address, Symbol), CallRule>` sorted by target address then function name, as the host requires. */
const calls = (rules: Rule[]) => xdr.ScVal.scvMap([...rules]
  .sort((a, b) => byAddress(a.target, b.target) || (a.fn < b.fn ? -1 : a.fn > b.fn ? 1 : 0))
  .map(({ target, fn, rule }) => new xdr.ScMapEntry({ key: vec([address(target), symbol(fn)]), val: rule })));
const addressMap = (entries: [string, xdr.ScVal][]) => xdr.ScVal.scvMap([...entries]
  .sort(([a], [b]) => byAddress(a, b))
  .map(([key, val]) => new xdr.ScMapEntry({ key: address(key), val })));

const blendSubmit: Rule = { target: pool, fn: "submit_with_allowance", rule: callRule(["Vault", "Vault", "Vault", "BlendRequests"], STABLE_BPS, true) };
const defindexWithdraw: Rule = { target: defindex, fn: "withdraw", rule: callRule(["Any", "Any", "Vault"], STABLE_BPS, false) };

/**
 * `PolicyV2` with guards, exposure caps and a `riskoff` role (Blend withdraw/repay
 * and DeFindex withdraw, checked on outcomes by the vault while paused too).
 */
function agentPolicy(): xdr.ScVal {
  const riskoffRole = struct({
    calls: calls([blendSubmit, defindexWithdraw]),
    member: address(riskoff.publicKey()),
    mode: vec([symbol("RiskOff")]),
    quota: struct({ calls_per_hour: u32(10), daily_cap_bps: u32(10_000), daily_loss_bps: u32(50), tx_cap_bps: u32(5_000) }),
  });
  return struct({
    assets: vec([address(testnet.usdc)]),
    calls: calls([
      blendSubmit,
      { target: defindex, fn: "deposit", rule: callRule(["Any", "Any", "Vault", "Any"], STABLE_BPS, false) },
      defindexWithdraw,
    ]),
    exposure_caps: addressMap([[pool, u32(6_000)], [defindex, u32(6_000)]]),
    // Invested DeFindex deposits move through its Blend strategy into the Blend pool.
    guards: addressMap([[defindex, vec([address(strategy), address(pool)])]]),
    limits: struct(Object.fromEntries(Object.entries(defaultLimits).map(([key, value]) => [key, u32(value)]))),
    protocols: vec([address(pool), address(defindex)]),
    roles: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: symbol("riskoff"), val: riskoffRole })]),
  });
}

async function main(): Promise<void> {
  await Promise.all([owner, agent, feePayer, riskoff].map(ensureAccount));
  let vault = record.vaults.find(v => v.id === "agent-prudent" && v.factory === fleet.factory);
  if (!vault) {
    const params = struct({
      asset: address(testnet.usdc), oracle: address(fleet.oracleRouter),
      protocol_recipient: address(fleet.keeper), registry: address(fleet.policyRegistry),
    });
    const deployed = await send(owner, call(fleet.factory, "deploy_vault", [address(owner.publicKey()), address(agent.publicKey()), params]));
    if (!deployed.returnValue) throw new Error(`deploy_vault ${deployed.txHash} returned no address`);
    vault = {
      id: "agent-prudent",
      name: "Agent Prudent (runtime test)",
      slug: "agent-prudent",
      strategy: "USDC yield on Blend and a DeFindex vault lending on Blend, run by the agent runtime with its own session key.",
      strategyId: "prudent",
      address: scValToNative(deployed.returnValue) as string,
      factory: fleet.factory,
      registry: fleet.policyRegistry,
      oracle: fleet.oracleRouter,
      owner: owner.publicKey(),
      agent: agent.publicKey(),
      assets: [testnet.usdc],
      adapters: [{ kind: "Blend", protocol: pool }, { kind: "DeFindex", protocol: defindex }],
      roles: {
        default: { member: agent.publicKey(), env: ENV.agent },
        riskoff: { member: riskoff.publicKey(), env: ENV.riskoff },
      },
      feePayer: { address: feePayer.publicKey(), env: ENV.feePayer },
      deployTx: deployed.txHash,
      adapterTxs: [],
    };
    record.vaults.push(vault);
    save();
    console.log(`VAULT ${vault.address} ${deployed.txHash}`);
  }
  const id = vault.address;
  if (!vault.policyTx) {
    vault.policyTx = (await send(owner, call(fleet.policyRegistry, "register", [address(id), agentPolicy()]))).txHash;
    save();
    console.log(`POLICY ${vault.policyTx}`);
  }
  const set = await read<{ protocol: string }[]>(owner, id, "adapters");
  for (const { kind, protocol } of vault.adapters) {
    if (set.some(adapter => adapter.protocol === protocol)) continue;
    const tx = (await send(owner, call(id, "set_adapter", [adapterKind(kind), address(protocol)]))).txHash;
    vault.adapterTxs.push(tx);
    save();
    console.log(`ADAPTER ${kind} ${protocol} ${tx}`);
  }
  if (!vault.depositTx) {
    await ensureBlendUsdc(owner, DEPOSIT);
    vault.depositTx = (await send(owner, call(id, "deposit", [address(owner.publicKey()), i128(DEPOSIT)]))).txHash;
    vault.deposit = DEPOSIT.toString();
    save();
    console.log(`DEPOSIT ${DEPOSIT} ${vault.depositTx}`);
  }
  const [nav, session, shares] = await Promise.all([
    read<bigint>(owner, id, "nav"),
    read<string | null>(owner, id, "session"),
    read<bigint>(owner, id, "balance", [address(owner.publicKey())]),
  ]);
  console.log(`CHECK ${id} nav=${nav} session=${session} owner_shares=${shares}`);
  if (nav <= 0n || session !== agent.publicKey()) throw new Error("The agent test vault does not read back as deployed");
}

main().catch(fail);
