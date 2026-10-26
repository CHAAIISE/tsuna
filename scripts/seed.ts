import { readFileSync } from "node:fs";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  alignSoroswap, aquariusReserves, deadline, deepenSoroswap, ensureAquariusPool, fund, seedAquarius, soroswap,
  soroswapReserves, toAmount, u128, aquarius,
} from "./lib/liquidity.js";
import { setTimeout as sleep } from "node:timers/promises";
import { contractExists, ensureAccount } from "./lib/pay.js";
import {
  LEVERAGE_MAX_DRAWDOWN_BPS, UNIT, adapterKind, address, balance, call, callRule, defaultLimits, fail, i128, policy, read, request, send,
  sendCosigned, signer, simulate, symbol, testnet, u32, vec, type Limits, type Permission, type PolicyExtras,
  type Quota, type Reserve, type RoleSpec,
} from "./lib/stellar.js";
import { readTestnet, writeTestnet, type AdapterName, type VaultRecord } from "./lib/testnet-deployment.js";

const DEFINDEX_FACTORY = "CDSCWE4GLNBYYTES2OCYDFQA2LLY4RBIAX6ZI32VSUXD7GO6HRPO4A32";
const DEFINDEX_BLEND_USDC_STRATEGY = "CALLOM5I7XLQPPOPQMYAHUWW4N7O3JKT42KQ4ASEEVBXDJQNJOALFSUY";
/** Soroswap XLM/USDC-Blend depth: a 0.1 % swap moves the price 10 bps, inside the 50 bps volatile tolerance with the 30 bps fee. */
const SOROSWAP_DEPTH = 3_000n * UNIT;
const AQUARIUS_DEPTH = 1_500n * UNIT;
/** First DeFindex deposit, invested into the Blend strategy so later deposits follow that allocation. */
const DEFINDEX_SEED = 10n * UNIT;
/** Loss tolerated per call: stablecoin moves 10 bps, anything priced against XLM 50 bps. */
const STABLE_BPS = 10;
const VOLATILE_BPS = 50;
/** Risk-off role: unwinds only, within a quota tighter than the default role's. */
const RISKOFF = "riskoff";
const RISKOFF_QUOTA: Quota = { tx_cap_bps: 5_000, daily_cap_bps: 10_000, calls_per_hour: 6, daily_loss_bps: 50 };

const admin = signer("LEASH_ADMIN_SECRET");
const agent = signer("LEASH_AGENT_SECRET");
const keeper = signer("LEASH_KEEPER_SECRET").publicKey();
const owner = admin.publicKey();
const riskoff = signer("LEASH_RISKOFF_SECRET");
const riskoffRole = (plan: VaultPlan): RoleSpec => ({
  member: riskoff.publicKey(), mode: "RiskOff", calls: plan.riskoff, quota: RISKOFF_QUOTA,
});
/** Full registry policy of `plan`, its risk-off role included. */
const planPolicy = (plan: VaultPlan) => policy(plan.assets, plan.calls, plan.protocols, plan.limits, {
  ...plan.extras, roles: { [RISKOFF]: riskoffRole(plan) },
});

const record = readTestnet();
const save = () => writeTestnet(record);
const liquidity: Record<string, string> = record.liquidity ??= {};
const protocols: Record<string, string> = record.protocols ??= {};
const [factory, registry, oracle] = (["factory", "policyRegistry", "oracleRouter"] as const).map(name => {
  const id = record[name];
  if (!id) throw new Error(`Missing ${name} in deployments/testnet.json: run scripts/deploy.ts first`);
  return id;
}) as [string, string, string];

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
const bool = (value: boolean) => xdr.ScVal.scvBool(value);
const str = (value: string) => nativeToScVal(value, { type: "string" });
/** Contract struct: a map of symbol keys in ordinal order. */
const struct = (fields: Record<string, xdr.ScVal>) => xdr.ScVal.scvMap(Object.keys(fields).sort()
  .map(key => new xdr.ScMapEntry({ key: symbol(key), val: fields[key] as xdr.ScVal })));
const price = (asset: string) => read<bigint>(admin, oracle, "price_strict", [address(asset)]);

/** Session-key call through the vault, printing its simulated resource use. */
async function execute(vault: string, target: string, fn: string, args: xdr.ScVal[]): Promise<string> {
  const operation = call(vault, "execute", [address(target), symbol(fn), vec(args)]);
  const { simulation } = await simulate(agent, operation);
  const { resources } = simulation.transactionData.build();
  const { readOnly, readWrite } = resources.footprint;
  const done = await send(agent, operation);
  console.log(`EXECUTE ${fn} ${done.txHash} instructions=${resources.instructions} entries=${readOnly.length + readWrite.length} writes=${readWrite.length} resource_fee=${simulation.minResourceFee}`);
  return done.txHash;
}

/** Own DeFindex USDC vault on the Blend strategy; the admin holds every role, including rebalance manager. */
async function ensureDefindexVault(): Promise<string> {
  if (liquidity.defindexVault && await contractExists(liquidity.defindexVault)) return liquidity.defindexVault;
  const roles = xdr.ScVal.scvMap([0, 1, 2, 3].map(role => new xdr.ScMapEntry({ key: u32(role), val: address(owner) })));
  const assets = vec([struct({
    address: address(testnet.usdc),
    strategies: vec([struct({ address: address(DEFINDEX_BLEND_USDC_STRATEGY), name: str("Blend USDC"), paused: bool(false) })]),
  })]);
  const metadata = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: str("name"), val: str("Tsuna Blend USDC") }),
    new xdr.ScMapEntry({ key: str("symbol"), val: str("lbUSDC") }),
  ]);
  const created = await send(admin, call(DEFINDEX_FACTORY, "create_defindex_vault", [
    roles, u32(0), assets, address(soroswap.router), metadata, bool(false),
  ]));
  if (!created.returnValue) throw new Error(`DeFindex vault creation ${created.txHash} returned no address`);
  const vault = scValToNative(created.returnValue) as string;
  liquidity.defindexVault = vault;
  liquidity.defindexCreateTx = created.txHash;
  save();
  console.log(`DEFINDEX_VAULT ${vault} ${created.txHash}`);
  await fund(admin, testnet.usdc, DEFINDEX_SEED);
  const seeded = await send(admin, call(vault, "deposit", [vec([i128(DEFINDEX_SEED)]), vec([i128(0n)]), address(owner), bool(false)]));
  liquidity.defindexSeedTx = seeded.txHash;
  const invested = await send(admin, call(vault, "rebalance", [address(owner), vec([
    vec([symbol("Invest"), address(DEFINDEX_BLEND_USDC_STRATEGY), i128(DEFINDEX_SEED)]),
  ])]));
  liquidity.defindexInvestTx = invested.txHash;
  save();
  console.log(`DEFINDEX_SEED ${toAmount(DEFINDEX_SEED)} USDC ${seeded.txHash} invested ${invested.txHash}`);
  return vault;
}

/** Trading and yield venues the demo vaults use. */
interface Venues {
  pair: string;
  aquariusPool: string;
  defindex: string;
}

async function seedLiquidity(): Promise<Venues> {
  const xlmPrice = await price(testnet.xlm);
  console.log(`ORACLE xlm=${xlmPrice} (USDC per XLM, 7 decimals)`);
  const pair = await read<string>(admin, soroswap.factory, "get_pair", [address(testnet.xlm), address(testnet.usdc)]);
  const aligned = await alignSoroswap(admin, pair, xlmPrice);
  if (aligned) liquidity.soroswapAlignTx = aligned;
  const deepened = await deepenSoroswap(admin, pair, SOROSWAP_DEPTH);
  if (deepened) liquidity.soroswapAddLiquidityTx = deepened;
  const reserves = await soroswapReserves(admin, pair);
  console.log(`SOROSWAP_RESERVES usdc=${toAmount(reserves.usdc)} xlm=${toAmount(reserves.xlm)} price=${reserves.usdc * UNIT / reserves.xlm}`);
  protocols.soroswapRouter = soroswap.router;
  protocols.soroswapFactory = soroswap.factory;
  protocols.soroswapPairXlmUsdc = pair;
  const cctp = JSON.parse(readFileSync(new URL("../deployments/cctp.testnet.json", import.meta.url), "utf8")) as { soroswapPair: string };
  protocols.soroswapPairUsdcBridge = cctp.soroswapPair;
  save();

  const recorded = liquidity.aquariusPool && liquidity.aquariusPoolIndex
    ? { pool: liquidity.aquariusPool, index: liquidity.aquariusPoolIndex }
    : undefined;
  const pool = recorded ?? await ensureAquariusPool(admin);
  liquidity.aquariusPool = pool.pool;
  liquidity.aquariusPoolIndex = pool.index;
  for (const [key, tx] of [["aquaTrustTx", "trustTx"], ["aquaBuyTx", "buyTx"], ["aquariusCreateTx", "createTx"]] as const) {
    const hash = (pool as Record<string, string | undefined>)[tx];
    if (hash) liquidity[key] = hash;
  }
  save();
  const seeded = await seedAquarius(admin, pool, await price(testnet.xlm), AQUARIUS_DEPTH);
  if (seeded.alignTx) liquidity.aquariusAlignTx = seeded.alignTx;
  if (seeded.depositTx) liquidity.aquariusDepositTx = seeded.depositTx;
  protocols.aquariusRouter = aquarius.router;
  protocols.aquariusPoolXlmUsdc = pool.pool;

  const defindex = await ensureDefindexVault();
  const managed = await read<{ asset: string; idle_amount: bigint; invested_amount: bigint }[]>(admin, defindex, "fetch_total_managed_funds");
  console.log(`DEFINDEX_FUNDS ${managed.map(m => `idle=${m.idle_amount} invested=${m.invested_amount}`).join(" ")}`);
  protocols.blendPool = testnet.pool;
  protocols.defindexFactory = DEFINDEX_FACTORY;
  protocols.defindexVault = defindex;
  protocols.defindexBlendUsdcStrategy = DEFINDEX_BLEND_USDC_STRATEGY;
  save();
  return { pair, aquariusPool: pool.pool, defindex };
}

interface VaultPlan {
  id: string;
  name: string;
  strategy: string;
  assets: string[];
  calls: Permission[];
  protocols: string[];
  extras: PolicyExtras;
  limits: Limits;
  adapters: [AdapterName, string][];
  deposit: bigint;
  /**
   * Allowlist of the `riskoff` role. Blend requests cannot be filtered by type, so the role
   * keeps the Blend call with vault destinations; RiskOff outcome checks refuse borrowing,
   * new collateral and swaps out of the base asset.
   */
  riskoff: Permission[];
  /** Initial session-key actions, each run once and recorded by name. */
  steps: [string, (vault: string) => Promise<string>][];
}

function plans({ pair, aquariusPool, defindex }: Venues): VaultPlan[] {
  const blendCall = (maxLoss: number) => ({
    target: testnet.pool, fn: "submit_with_allowance", rule: callRule(["Vault", "Vault", "Vault", "BlendRequests"], maxLoss, true),
  });
  const swapCall = {
    target: soroswap.router, fn: "swap_exact_tokens_for_tokens", rule: callRule(["Any", "Any", "Assets", "Vault", "Any"], VOLATILE_BPS, false),
  };
  // Buys XLM with 0.1 % of the pair's USDC depth right after realigning it on the oracle, so the
  // output clears the vault's floor (oracle quote less 50 bps).
  const buyXlm = async (vault: string) => {
    await alignSoroswap(admin, pair, await price(testnet.xlm));
    const [usdcPrice, xlmPrice, reserves] = await Promise.all([price(testnet.usdc), price(testnet.xlm), soroswapReserves(admin, pair)]);
    const amountIn = reserves.usdc / 1_000n;
    const minOut = ceil(amountIn * usdcPrice / xlmPrice * BigInt(10_000 - VOLATILE_BPS), 10_000n);
    return execute(vault, soroswap.router, "swap_exact_tokens_for_tokens", [
      i128(amountIn), i128(minOut), vec([address(testnet.usdc), address(testnet.xlm)]), address(vault), deadline(),
    ]);
  };
  const blendRequest = (vault: string, asset: string, amount: bigint, type: number) => execute(vault, testnet.pool, "submit_with_allowance", [
    address(vault), address(vault), address(vault), vec([request(asset, amount, type)]),
  ]);
  return [
    {
      id: "prudent",
      name: "Prudent",
      strategy: "USDC yield: supplies Blend and deposits in a DeFindex vault that lends on Blend. Stablecoin calls only, 10 bps loss per call.",
      assets: [testnet.usdc],
      calls: [
        blendCall(STABLE_BPS),
        { target: defindex, fn: "deposit", rule: callRule(["Any", "Any", "Vault", "Any"], STABLE_BPS, false) },
        { target: defindex, fn: "withdraw", rule: callRule(["Any", "Any", "Vault"], STABLE_BPS, false) },
        // Lets the creator move DeFindex shares between their own accounts. The recipient is left
        // open on purpose: shares sent anywhere else lower the NAV, which the vault refuses.
        { target: defindex, fn: "transfer", rule: callRule(["Vault", "Any", "Any"], STABLE_BPS, false) },
      ],
      protocols: [testnet.pool, defindex],
      // Invested DeFindex deposits move through its Blend strategy into the Blend pool.
      extras: { guards: { [defindex]: [DEFINDEX_BLEND_USDC_STRATEGY, testnet.pool] }, exposureCaps: { [testnet.pool]: 6_000, [defindex]: 6_000 } },
      limits: defaultLimits,
      adapters: [["Blend", testnet.pool], ["DeFindex", defindex]],
      deposit: 300n * UNIT,
      riskoff: [
        blendCall(STABLE_BPS),
        { target: defindex, fn: "withdraw", rule: callRule(["Any", "Any", "Vault"], STABLE_BPS, false) },
      ],
      steps: [
        ["blend-supply", vault => blendRequest(vault, testnet.usdc, 100n * UNIT, 0)],
        ["defindex-deposit", vault => execute(vault, defindex, "deposit", [vec([i128(100n * UNIT)]), vec([i128(0n)]), address(vault), bool(true)])],
      ],
    },
    {
      id: "leverage",
      name: "Leverage",
      strategy: "XLM collateral on Blend with USDC borrowed against it, swapped on Soroswap. Health factor kept above 1.3, 50 bps loss per call.",
      assets: [testnet.usdc, testnet.xlm],
      calls: [blendCall(VOLATILE_BPS), swapCall],
      protocols: [testnet.pool, soroswap.router],
      extras: { guards: { [soroswap.router]: [pair] }, exposureCaps: { [testnet.pool]: 7_000 } },
      limits: { ...defaultLimits, min_health_factor_bps: 13_000, max_drawdown_bps: LEVERAGE_MAX_DRAWDOWN_BPS },
      adapters: [["Blend", testnet.pool], ["Soroswap", soroswap.router]],
      deposit: 200n * UNIT,
      riskoff: [blendCall(VOLATILE_BPS)],
      steps: [
        ["soroswap-buy-xlm", buyXlm],
        ["blend-collateral-xlm", async vault => blendRequest(vault, testnet.xlm, await balance(admin, vault, testnet.xlm), 2)],
        ["blend-borrow-usdc", async vault => {
          // Health factor 2 at oracle prices: debt = collateral value × c_factor × l_factor / 2.
          const [xlmReserve, usdcReserve, positions, xlmPrice] = await Promise.all([
            read<Reserve>(admin, testnet.pool, "get_reserve", [address(testnet.xlm)]),
            read<Reserve>(admin, testnet.pool, "get_reserve", [address(testnet.usdc)]),
            read<{ collateral: Record<string, bigint> }>(admin, testnet.pool, "get_positions", [address(vault)]),
            price(testnet.xlm),
          ]);
          const collateral = (positions.collateral[xlmReserve.config.index] ?? 0n) * xlmReserve.data.b_rate / 1_000_000_000_000n;
          const value = collateral * xlmPrice / UNIT;
          const borrow = value * BigInt(xlmReserve.config.c_factor) * BigInt(usdcReserve.config.l_factor) / (2n * UNIT * UNIT);
          return blendRequest(vault, testnet.usdc, borrow, 4);
        }],
      ],
    },
    {
      id: "liquidity",
      name: "Liquidity",
      strategy: "Liquidity in the Aquarius XLM/USDC-Blend pool, XLM inventory bought on Soroswap. LP valued at oracle prices, 50 bps loss per call.",
      assets: [testnet.usdc, testnet.xlm],
      calls: [
        { target: aquariusPool, fn: "deposit", rule: callRule(["Vault", "Any", "Any"], VOLATILE_BPS, false) },
        { target: aquariusPool, fn: "withdraw", rule: callRule(["Vault", "Any", "Any"], VOLATILE_BPS, false) },
        swapCall,
      ],
      protocols: [aquariusPool, soroswap.router],
      extras: { guards: { [soroswap.router]: [pair] }, exposureCaps: { [aquariusPool]: 6_000 } },
      limits: defaultLimits,
      adapters: [["Aquarius", aquariusPool], ["Soroswap", soroswap.router]],
      deposit: 200n * UNIT,
      riskoff: [{ target: aquariusPool, fn: "withdraw", rule: callRule(["Vault", "Any", "Any"], VOLATILE_BPS, false) }],
      steps: [
        ["soroswap-buy-xlm", buyXlm],
        ["aquarius-deposit", async vault => {
          // The vault authorizes exact transfers, so the amounts must be the ones the pool takes.
          const [xlm, reserves, tokens] = await Promise.all([
            balance(admin, vault, testnet.xlm),
            aquariusReserves(admin, aquariusPool),
            read<string[]>(admin, aquariusPool, "get_tokens"),
          ]);
          const candidates = [xlm * reserves.usdc / reserves.xlm, ceil(xlm * reserves.usdc, reserves.xlm)];
          for (const usdc of candidates) {
            const args = [address(vault), vec(tokens.map(token => u128(token === testnet.usdc ? usdc : xlm))), u128(0n)];
            const fits = await simulate(agent, call(vault, "execute", [address(aquariusPool), symbol("deposit"), vec(args)]))
              .then(() => true, () => false);
            if (fits) return execute(vault, aquariusPool, "deposit", args);
          }
          throw new Error(`No Aquarius deposit of ${xlm} XLM units matches the pool ratio`);
        }],
      ],
    },
  ];
}

async function ensureVault(plan: VaultPlan): Promise<VaultRecord> {
  let vault = record.vaults.find(v => v.id === plan.id && v.factory === factory);
  if (vault && !await contractExists(vault.address)) {
    record.vaults = record.vaults.filter(v => v !== vault);
    vault = undefined;
  }
  if (!vault) {
    const params = struct({
      asset: address(testnet.usdc), oracle: address(oracle), protocol_recipient: address(keeper), registry: address(registry),
    });
    const deployed = await send(admin, call(factory, "deploy_vault", [address(owner), address(agent.publicKey()), params]));
    if (!deployed.returnValue) throw new Error(`deploy_vault ${deployed.txHash} returned no address`);
    vault = {
      id: plan.id, name: plan.name, slug: plan.id, strategy: plan.strategy, roles: ["default"],
      address: scValToNative(deployed.returnValue) as string, factory, owner, agent: agent.publicKey(), registry, oracle,
      assets: plan.assets, adapters: plan.adapters.map(([kind, protocol]) => ({ kind, protocol })),
      deployTx: deployed.txHash, adapterTxs: [], executions: [],
    };
    record.vaults.push(vault);
    save();
    console.log(`VAULT ${plan.name} ${vault.address} ${deployed.txHash}`);
  }
  const id = vault.address;
  if (!await read<unknown>(admin, registry, "policy", [address(id)])) {
    // A fresh vault gets its risk-off role in the initial policy, in force at once.
    vault.policyTx = (await send(admin, call(registry, "register", [address(id), planPolicy(plan)]))).txHash;
    save();
    console.log(`POLICY ${plan.name} ${vault.policyTx}`);
  }
  const set = await read<{ protocol: string }[]>(admin, id, "adapters");
  for (const [kind, protocol] of plan.adapters) {
    if (set.some(adapter => adapter.protocol === protocol)) continue;
    const tx = (await send(admin, call(id, "set_adapter", [adapterKind(kind), address(protocol)]))).txHash;
    vault.adapterTxs.push(tx);
    save();
    console.log(`ADAPTER ${plan.name} ${kind} ${protocol} ${tx}`);
  }
  if (!vault.depositTx) {
    await fund(admin, testnet.usdc, plan.deposit);
    vault.depositTx = (await send(admin, call(id, "deposit", [address(owner), i128(plan.deposit)]))).txHash;
    vault.deposit = plan.deposit.toString();
    save();
    console.log(`DEPOSIT ${plan.name} ${toAmount(plan.deposit)} USDC ${vault.depositTx}`);
  }
  for (const [action, step] of plan.steps) {
    if (vault.executions.some(done => done.action === action)) continue;
    vault.executions.push({ action, tx: await step(id) });
    save();
  }
  return vault;
}

interface StoredPolicy {
  /** Keyed `<target>,<fn>` once converted from the contract map. */
  calls?: Record<string, unknown>;
  roles?: Record<string, { member: string; mode: string[]; calls: Record<string, unknown>; quota: Record<string, number> }> | null;
}

const roleInForce = (stored: StoredPolicy | null) => stored?.roles?.[RISKOFF]?.member === riskoff.publicKey();
const planInForce = (stored: StoredPolicy | null, plan: VaultPlan) => roleInForce(stored)
  && plan.calls.every(({ target, fn }) => stored?.calls?.[`${target},${fn}`] !== undefined);

/**
 * Proposes the plan's full policy (risk-off role included) on a vault whose policy in force
 * lacks part of it: `null` when nothing is missing, else the apply ETA.
 */
async function proposePlan(vault: VaultRecord, plan: VaultPlan): Promise<bigint | null> {
  if (planInForce(await read<StoredPolicy | null>(admin, registry, "policy", [address(vault.address)]), plan)) return null;
  const pendingOf = () => read<{ policy: StoredPolicy; eta: bigint } | null>(admin, registry, "pending_policy", [address(vault.address)]);
  let pending = await pendingOf();
  if (!pending || !planInForce(pending.policy, plan)) {
    const proposed = await send(admin, call(registry, "propose_policy", [address(vault.address), planPolicy(plan)]));
    vault.policyUpdateTxs = { propose: proposed.txHash };
    save();
    pending = await pendingOf();
    if (!pending) throw new Error(`propose_policy ${proposed.txHash} left no pending policy`);
    console.log(`POLICY_PROPOSED ${vault.name} eta=${pending.eta} ${proposed.txHash}`);
  }
  return pending.eta;
}

/** Applies the pending policy once the registry timelock has passed on-chain. */
async function applyPending(vault: VaultRecord, eta: bigint): Promise<void> {
  const wait = Number(eta) * 1000 - Date.now();
  if (wait > 0) {
    console.log(`POLICY_TIMELOCK ${vault.name} waiting ${Math.ceil(wait / 1000)} s`);
    await sleep(wait);
  }
  // Ledger close times trail the wall clock by a few seconds.
  for (let attempt = 1; ; attempt++) {
    try {
      const applied = await send(admin, call(registry, "apply_policy", [address(vault.address)]));
      vault.policyUpdateTxs = { ...vault.policyUpdateTxs, apply: applied.txHash };
      console.log(`POLICY_APPLIED ${vault.name} ${applied.txHash}`);
      return;
    } catch (error) {
      if (attempt === 12) throw error;
      await sleep(10_000);
    }
  }
}

function recordRiskoff(vault: VaultRecord): void {
  vault.roles = ["default", RISKOFF];
  vault.riskoffMember = riskoff.publicKey();
  save();
}

/**
 * Risk-off proof on Leverage: the role repays a sliver of the Blend debt. The vault grants the
 * pool the repaid allowance itself; the call passes because the health factor only rises.
 */
async function riskoffRepay(vault: VaultRecord): Promise<void> {
  if (vault.executions.some(done => done.action === "riskoff-blend-repay")) return;
  await ensureAccount(riskoff);
  const operation = call(vault.address, "execute_as", [
    address(riskoff.publicKey()), symbol(RISKOFF), address(testnet.pool), symbol("submit_with_allowance"),
    vec([address(vault.address), address(vault.address), address(vault.address), vec([request(testnet.usdc, UNIT / 100n, 5)])]),
  ]);
  const repaid = await sendCosigned(admin, operation, [riskoff]);
  vault.executions.push({ action: "riskoff-blend-repay", tx: repaid.txHash });
  save();
  console.log(`RISKOFF_REPAY ${vault.name} 0.01 USDC ${repaid.txHash}`);
}

async function main(): Promise<void> {
  const venues = await seedLiquidity();
  const fleet = plans(venues);
  const vaults = new Map<VaultPlan, VaultRecord>();
  for (const plan of fleet) vaults.set(plan, await ensureVault(plan));
  const pending: [VaultRecord, bigint][] = [];
  for (const [plan, vault] of vaults) {
    const eta = await proposePlan(vault, plan);
    if (eta === null) recordRiskoff(vault);
    else pending.push([vault, eta]);
  }
  for (const [vault, eta] of pending) {
    await applyPending(vault, eta);
    recordRiskoff(vault);
  }
  const leverage = record.vaults.find(vault => vault.id === "leverage" && vault.factory === factory);
  if (leverage) await riskoffRepay(leverage);
  for (const [plan, vault] of vaults) {
    const [nav, vaultOwner, vaultRegistry, vaultOracle, shares, health, stored] = await Promise.all([
      read<bigint>(admin, vault.address, "nav"),
      read<string>(admin, vault.address, "owner"),
      read<string>(admin, vault.address, "registry"),
      read<string>(admin, vault.address, "oracle"),
      read<bigint>(admin, vault.address, "balance", [address(owner)]),
      read<bigint>(admin, vault.address, "health_factor"),
      read<StoredPolicy | null>(admin, registry, "policy", [address(vault.address)]),
    ]);
    // `health_factor()` is i128::MAX without debt.
    const hf = health >= 2n ** 126n ? "none" : `${Number(health) / 10_000}`;
    console.log(`CHECK ${vault.name} ${vault.address} nav=${nav} (${toAmount(nav)} USDC) owner=${vaultOwner} registry=${vaultRegistry} oracle=${vaultOracle} health_factor=${hf} creator_shares=${shares}`);
    const riskoffRule = stored?.roles?.[RISKOFF];
    console.log(`ROLE ${vault.name} ${RISKOFF} member=${riskoffRule?.member} mode=${riskoffRule?.mode.join("")} calls=${Object.keys(riskoffRule?.calls ?? {}).length} quota=${JSON.stringify(riskoffRule?.quota)}`);
    if (nav <= 0n || vaultOwner !== owner || vaultRegistry !== registry || vaultOracle !== oracle || !planInForce(stored, plan)) {
      throw new Error(`${vault.name} does not read back as deployed`);
    }
  }
  const count = await read<number>(admin, factory, "vault_count");
  console.log(`SEEDED ${record.vaults.length} vaults (factory vault_count=${count})`);
}

main().catch(fail);
