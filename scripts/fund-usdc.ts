import { pathToFileURL } from "node:url";
import { Asset, Operation } from "@stellar/stellar-sdk";
import {
  UNIT, RATE, address, balance, call, fail, horizon, i128, read, request,
  send, server, signer, symbol, testnet, vec, type Positions, type Reserve,
} from "./lib/stellar.js";

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export async function fundUsdc(target = 6_000n * UNIT): Promise<void> {
  const admin = signer("LEASH_ADMIN_SECRET");
  const owner = admin.publicKey();
  try {
    await server.getAccount(owner);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("not found")) throw error;
    const funded = await server.fundAddress(owner);
    console.log(`FRIENDBOT ${funded.txHash}`);
  }
  const account = await horizon.loadAccount(owner);
  if (!account.balances.some(b => b.asset_type !== "native" && "asset_issuer" in b && b.asset_issuer === testnet.issuer && b.asset_code === "USDC")) {
    const trust = await send(admin, Operation.changeTrust({ asset: new Asset("USDC", testnet.issuer) }), false);
    console.log(`TRUST_USDC ${trust.txHash}`);
  }
  const held = await balance(admin, owner);
  if (held >= target) {
    console.log(`USDC_STOCK ${held} stroops`);
    return;
  }
  const borrow = target - held;
  const [xlm, usdc, positions, config] = await Promise.all([
    read<Reserve>(admin, testnet.pool, "get_reserve", [address(testnet.xlm)]),
    read<Reserve>(admin, testnet.pool, "get_reserve", [address(testnet.usdc)]),
    read<Positions>(admin, testnet.pool, "get_positions", [address(owner)]),
    read<{ oracle: string }>(admin, testnet.pool, "get_config"),
  ]);
  const price = async (asset: string) => {
    const value = await read<{ price: bigint } | null>(admin, config.oracle, "lastprice", [vec([symbol("Stellar"), address(asset)])]);
    if (!value || value.price <= 0n) throw new Error(`Missing Blend oracle price for ${asset}`);
    return value.price;
  };
  const [xlmPrice, usdcPrice] = await Promise.all([price(testnet.xlm), price(testnet.usdc)]);
  if (xlm.config.decimals !== 7 || usdc.config.decimals !== 7) throw new Error("Expected seven-decimal reserves");
  const debt = ceil((positions.liabilities[usdc.config.index] ?? 0n) * usdc.data.d_rate, RATE) + borrow;
  // Target a 1.75 health factor using Blend's collateral/liability weights.
  const required = ceil(debt * usdcPrice * 175n * UNIT * UNIT,
    xlmPrice * 100n * BigInt(xlm.config.c_factor) * BigInt(usdc.config.l_factor));
  const collateral = (positions.collateral[xlm.config.index] ?? 0n) * xlm.data.b_rate / RATE;
  const additional = required > collateral ? required - collateral : 0n;
  let available = await balance(admin, owner, testnet.xlm) - 1_000n * UNIT;
  const seen = new Set([owner]);
  for (const name of ["LEASH_AGENT_SECRET", "LEASH_KEEPER_SECRET", "E2E_USER_SECRET"]) {
    if (available >= additional) break;
    const donor = signer(name);
    if (seen.has(donor.publicKey())) continue;
    seen.add(donor.publicKey());
    const spare = await balance(admin, donor.publicKey(), testnet.xlm) - 1_000n * UNIT;
    const missing = additional - available;
    const amount = spare < missing ? spare : missing;
    if (amount <= 0n) continue;
    const tx = await send(donor, call(testnet.xlm, "transfer", [address(donor.publicKey()), address(owner), i128(amount)]));
    available += amount;
    console.log(`COLLECT_XLM ${tx.txHash}`);
  }
  if (available < additional) throw new Error(`Insufficient test XLM: need ${additional}, available ${available}; fund the configured testnet burners with Friendbot`);
  // Separate writes keep each resource fee below Stellar's uint32 fee limit.
  if (additional > 0n) {
    const supplied = await send(admin, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.xlm, additional, 2)])]));
    console.log(`SUPPLY_COLLATERAL ${supplied.txHash}`);
  }
  const funded = await send(admin, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.usdc, borrow, 4)])]));
  console.log(`BORROW_USDC ${funded.txHash}`);
  const stock = await balance(admin, owner);
  if (stock < target) throw new Error(`USDC stock below target: ${stock}`);
  console.log(`USDC_STOCK ${stock} stroops`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fundUsdc().catch(fail);
}
