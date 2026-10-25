import { pathToFileURL } from "node:url";
import {
  UNIT, RATE, address, balance, call, fail, horizon, read, request,
  send, signer, symbol, testnet, vec, type Positions, type Reserve,
} from "./lib/stellar.js";
import { ensureAccount, topUpXlm } from "./lib/friendbot.js";
import { recordPasskeyDeployment } from "./lib/passkey-deployment.js";

const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
/** XLM kept outside Blend for fees and reserves. */
const XLM_FLOAT = 1_000n * UNIT;

/**
 * Stocks the demo faucet with Blend testnet USDC: the Blend USDC order book is
 * empty, so the faucet supplies Friendbot XLM as collateral and borrows USDC.
 */
export async function fundFaucet(target: bigint): Promise<void> {
  const faucet = signer("LEASH_FAUCET_SECRET");
  const owner = faucet.publicKey();
  await ensureAccount(faucet);
  recordPasskeyDeployment({ faucet: owner });

  const account = await horizon.loadAccount(owner);
  const trusted = account.balances.some(b => b.asset_type !== "native" && "asset_issuer" in b
    && b.asset_issuer === testnet.issuer && b.asset_code === "USDC");
  if (!trusted) {
    // CAP-73: the SAC creates the trustline itself, no changeTrust needed.
    const trust = await send(faucet, call(testnet.usdc, "trust", [address(owner)]));
    console.log(`TRUST_USDC ${trust.txHash}`);
    recordPasskeyDeployment({}, { faucetTrustline: trust.txHash });
  }

  const held = await balance(faucet, owner);
  if (held >= target) {
    console.log(`FAUCET_STOCK ${held} stroops`);
    return;
  }
  const borrow = target - held;
  const [xlm, usdc, positions, config] = await Promise.all([
    read<Reserve>(faucet, testnet.pool, "get_reserve", [address(testnet.xlm)]),
    read<Reserve>(faucet, testnet.pool, "get_reserve", [address(testnet.usdc)]),
    read<Positions>(faucet, testnet.pool, "get_positions", [address(owner)]),
    read<{ oracle: string }>(faucet, testnet.pool, "get_config"),
  ]);
  const price = async (asset: string) => {
    const value = await read<{ price: bigint } | null>(faucet, config.oracle, "lastprice", [vec([symbol("Stellar"), address(asset)])]);
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
  console.log(`COLLATERAL_NEEDED ${additional / UNIT} XLM for ${borrow / UNIT} USDC`);

  if (additional > 0n) {
    await topUpXlm(faucet, additional + XLM_FLOAT);
    // Separate writes keep each resource fee below Stellar's uint32 fee limit.
    const supplied = await send(faucet, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.xlm, additional, 2)])]));
    console.log(`SUPPLY_COLLATERAL ${supplied.txHash}`);
    recordPasskeyDeployment({}, { faucetCollateral: supplied.txHash });
  }
  const funded = await send(faucet, call(testnet.pool, "submit", [address(owner), address(owner), address(owner), vec([request(testnet.usdc, borrow, 4)])]));
  console.log(`BORROW_USDC ${funded.txHash}`);
  recordPasskeyDeployment({}, { faucetBorrow: funded.txHash });
  const stock = await balance(faucet, owner);
  if (stock < target) throw new Error(`Faucet stock below target: ${stock}`);
  console.log(`FAUCET_STOCK ${stock} stroops`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const usdc = BigInt(process.argv[2] ?? "8000");
  fundFaucet(usdc * UNIT).catch(fail);
}
