import { alignSoroswap, aquariusReserves, deepenSoroswap, seedAquarius, soroswapReserves, toAmount } from "./lib/liquidity.js";
import { UNIT, address, read, signer, testnet } from "./lib/stellar.js";
import { readTestnet, writeTestnet } from "./lib/testnet-deployment.js";

async function main(): Promise<void> {
  const deployment = readTestnet();
  const key = signer("LEASH_ADMIN_SECRET");
  const pair = deployment.protocols?.soroswapPairXlmUsdc;
  const pool = deployment.protocols?.aquariusPoolXlmUsdc;
  const index = deployment.liquidity?.aquariusPoolIndex;
  const oracle = deployment.oracleRouter;
  if (!pair || !pool || !index || !oracle) throw new Error("Seed the testnet pools first");
  const price = () => read<bigint>(key, oracle, "price_strict", [address(testnet.xlm)]);
  const save = (name: string, hash: string | null | undefined) => {
    if (!hash) return;
    deployment.liquidity = { ...deployment.liquidity, [name]: hash };
    writeTestnet(deployment);
  };

  // At parity, 10 USDC against this reserve costs about 37 bps including the 30 bps fee.
  save("soroswapAddLiquidityTx", await deepenSoroswap(key, pair, 15_000n * UNIT));
  save("soroswapAlignTx", await alignSoroswap(key, pair, await price()));
  const aquarius = await seedAquarius(key, { pool, index }, await price(), 1_500n * UNIT);
  save("aquariusAlignTx", aquarius.alignTx);
  save("aquariusDepositTx", aquarius.depositTx);

  const [oraclePrice, reserves, lpReserves] = await Promise.all([
    price(), soroswapReserves(key, pair), aquariusReserves(key, pool),
  ]);
  console.log(`ORACLE xlm_usdc=${oraclePrice}`);
  console.log(`SOROSWAP usdc=${toAmount(reserves.usdc)} xlm=${toAmount(reserves.xlm)} price=${reserves.usdc * UNIT / reserves.xlm}`);
  console.log(`AQUARIUS usdc=${toAmount(lpReserves.usdc)} xlm=${toAmount(lpReserves.xlm)} price=${lpReserves.usdc * UNIT / lpReserves.xlm}`);
  for (const amount of [5n, 10n, 25n, 50n]) {
    const input = amount * UNIT;
    const expectedOut = input * 9_970n * reserves.xlm / (reserves.usdc * 10_000n + input * 9_970n);
    const minOut = (input * UNIT * 9_950n + oraclePrice * 10_000n - 1n) / (oraclePrice * 10_000n);
    console.log(`QUOTE usdc=${amount} xlm=${toAmount(expectedOut)} min=${toAmount(minOut)} executable=${expectedOut >= minOut}`);
    if (amount <= 10n && expectedOut < minOut) throw new Error("Pool drifted outside the oracle minimum; align again before running Liquidity");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
