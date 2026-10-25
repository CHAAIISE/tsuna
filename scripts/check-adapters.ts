import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { fundUsdc } from "./fund-usdc.js";
import {
  RATE, UNIT, adapterKind, address, balance, call, callRule, defaultLimits, deployContract, deployment, fail, i128,
  policy, read, request, send, signer, simulate, symbol, testnet, u64, vec, type Positions, type Reserve,
} from "./lib/stellar.js";

/** DeFindex USDC vault on testnet (same USDC as the Blend pool). */
const DEFINDEX = "CBMVK2JK6NTOT2O4HNQAIQFJY232BHKGLIMXDVQVHIIZKDACXDFZDWHN";
const POLICY_TIMELOCK = 600n;

const admin = signer("LEASH_ADMIN_SECRET");
const agent = signer("LEASH_AGENT_SECRET");
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

/**
 * NAV recomputed from raw protocol reads, independently of the vault's adapters: idle USDC,
 * Blend supply/collateral at b_rate less debt at d_rate per reserve, DeFindex shares × the
 * DeFindex vault's own per-share redemption amounts. Non-USDC amounts go through the oracle router.
 */
async function offChainNav(vault: string, oracle: string) {
  const [idle, reserves, positions, dfShares, dfAssets] = await Promise.all([
    balance(admin, vault),
    read<string[]>(admin, testnet.pool, "get_reserve_list"),
    read<Positions>(admin, testnet.pool, "get_positions", [address(vault)]),
    read<bigint>(admin, DEFINDEX, "balance", [address(vault)]),
    read<{ address: string }[]>(admin, DEFINDEX, "get_assets"),
  ]);
  const quote = async (asset: string) => {
    const [price, decimals] = await Promise.all([
      read<bigint>(admin, oracle, "price_strict", [address(asset)]),
      read<number>(admin, asset, "decimals"),
    ]);
    return { price, unit: 10n ** BigInt(decimals) };
  };
  const base = await quote(testnet.usdc);
  const value = async (asset: string, amount: bigint, up: boolean) => {
    if (asset === testnet.usdc || amount === 0n) return amount;
    const { price, unit } = await quote(asset);
    const [n, d] = [amount * price * base.unit, base.price * unit];
    return up ? ceil(n, d) : n / d;
  };
  let blend = 0n;
  const indices = new Set([positions.supply, positions.collateral, positions.liabilities].flatMap(Object.keys));
  for (const index of indices) {
    const asset = reserves[Number(index)];
    if (!asset) throw new Error(`Unknown Blend reserve ${index}`);
    const reserve = await read<Reserve>(admin, testnet.pool, "get_reserve", [address(asset)]);
    const released = (positions.supply[index] ?? 0n) * reserve.data.b_rate / RATE
      + (positions.collateral[index] ?? 0n) * reserve.data.b_rate / RATE;
    const owed = ceil((positions.liabilities[index] ?? 0n) * reserve.data.d_rate, RATE);
    blend += await value(asset, released, false) - await value(asset, owed, true);
  }
  let defindex = 0n;
  if (dfShares > 0n) {
    const amounts = await read<bigint[]>(admin, DEFINDEX, "get_asset_amounts_per_shares", [i128(dfShares)]);
    for (const [i, set] of dfAssets.entries()) defindex += await value(set.address, amounts[i] ?? 0n, false);
  }
  return { idle, blend, defindex, dfShares, blendSupply: positions.supply[3] ?? 0n, total: idle + blend + defindex };
}

async function compare(vault: string, oracle: string, label: string) {
  const [onChain, off] = await Promise.all([read<bigint>(admin, vault, "nav"), offChainNav(vault, oracle)]);
  const gap = onChain > off.total ? onChain - off.total : off.total - onChain;
  console.log(`${label} NAV_ONCHAIN=${onChain} NAV_OFFCHAIN=${off.total} (idle=${off.idle} blend=${off.blend} defindex=${off.defindex}) gap=${gap} gap_bps=${Number(gap * 10_000n * 1_000n / (onChain || 1n)) / 1_000}`);
  if (gap * 10_000n >= onChain) throw new Error(`${label}: NAV gap of ${gap} is not below 1 bps of ${onChain}`);
  return off;
}

async function main(): Promise<void> {
  await fundUsdc();
  const oracle = await deployment("oracleRouter");
  execFileSync("stellar", ["contract", "build", "--manifest-path", "contracts/Cargo.toml", "--package", "agent-vault"], { stdio: "inherit" });
  execFileSync("stellar", ["contract", "build", "--manifest-path", "contracts/Cargo.toml", "--package", "policy-registry"], { stdio: "inherit" });
  const registry = await deployContract(admin, "policy_registry", [u64(POLICY_TIMELOCK)]);
  console.log(`REGISTRY ${registry.id} ${registry.txHash}`);
  const deployed = await deployContract(admin, "agent_vault", [
    address(admin.publicKey()), address(agent.publicKey()), address(testnet.usdc),
    address(signer("LEASH_KEEPER_SECRET").publicKey()), address(oracle), address(registry.id),
  ]);
  const vault = deployed.id;
  console.log(`VAULT ${vault} ${deployed.txHash}`);
  // DeFindex pulls deposits with `transfer` from the vault: no approval, the vault itself
  // authorizes that exact transfer. Its share rounding can cost one unit, inside 10 bps.
  const rules = policy([testnet.usdc], [
    { target: testnet.pool, fn: "submit_with_allowance", rule: callRule(["Vault", "Vault", "Vault", "BlendRequests"], 10, true) },
    { target: DEFINDEX, fn: "deposit", rule: callRule(["Any", "Any", "Vault", "Any"], 10, false) },
    { target: DEFINDEX, fn: "withdraw", rule: callRule(["Any", "Any", "Vault"], 10, false) },
  ], [testnet.pool, DEFINDEX], defaultLimits);
  console.log(`POLICY_REGISTERED ${(await send(admin, call(registry.id, "register", [address(vault), rules]))).txHash}`);
  for (const [kind, protocol] of [["Blend", testnet.pool], ["DeFindex", DEFINDEX]] as const) {
    const set = await send(admin, call(vault, "set_adapter", [adapterKind(kind), address(protocol)]));
    console.log(`ADAPTER ${kind} ${protocol} ${set.txHash}`);
  }
  const amount = 100n * UNIT;
  const deposited = await send(admin, call(vault, "deposit", [address(admin.publicKey()), i128(amount)]));
  console.log(`DEPOSITED ${deposited.txHash} assets=${amount}`);
  const invest = 40n * UNIT;
  const supplied = await send(agent, call(vault, "execute", [
    address(testnet.pool), symbol("submit_with_allowance"),
    vec([address(vault), address(vault), address(vault), vec([request(testnet.usdc, invest, 0)])]),
  ]));
  console.log(`BLEND_SUPPLY ${supplied.txHash} amount=${invest}`);
  const depositOp = call(vault, "execute", [
    address(DEFINDEX), symbol("deposit"),
    vec([vec([i128(invest)]), vec([i128(0n)]), address(vault), nativeToScVal(false)]),
  ]);
  const { simulation } = await simulate(agent, depositOp);
  const { resources } = simulation.transactionData.build();
  const { readOnly, readWrite } = resources.footprint;
  console.log(`EXECUTE_COST positions=2 instructions=${resources.instructions} read_entries=${readOnly.length + readWrite.length} write_entries=${readWrite.length} write_bytes=${resources.writeBytes} resource_fee=${simulation.minResourceFee}`);
  assert(rpc.Api.isSimulationSuccess(simulation));
  // The agent signs only `execute`; the transfer into DeFindex is authorized by the vault.
  assert.equal(simulation.result?.auth.length, 1, "Only the session key's authorization may be required");
  const dfDeposited = await send(agent, depositOp);
  console.log(`DEFINDEX_DEPOSIT ${dfDeposited.txHash} amount=${invest}`);
  const before = await compare(vault, oracle, "HOLDING");
  assert(before.blend > 0n && before.dfShares > 0n, "The vault must hold Blend and DeFindex positions");
  // Pro-rata exit: half of the depositor's shares unwinds half of each position.
  const shares = await read<bigint>(admin, vault, "balance", [address(admin.publicKey())]);
  const withdrawn = await send(admin, call(vault, "withdraw", [address(admin.publicKey()), i128(shares / 2n)]));
  assert(withdrawn.returnValue);
  const after = await compare(vault, oracle, "AFTER_WITHDRAW");
  const halved = (now: bigint, then: bigint) => now * 1_000n >= then * 495n && now * 1_000n <= then * 505n;
  assert(halved(after.blendSupply, before.blendSupply), "Blend supply must be halved");
  assert(halved(after.dfShares, before.dfShares), "DeFindex shares must be halved");
  console.log(`WITHDRAWN ${withdrawn.txHash} shares=${shares / 2n} blend_b_tokens=${before.blendSupply}->${after.blendSupply} defindex_shares=${before.dfShares}->${after.dfShares}`);
  console.log(`PASS on-chain NAV matches raw Blend + DeFindex reads within 1 bps; vault ${vault}`);
}

main().catch(fail);
