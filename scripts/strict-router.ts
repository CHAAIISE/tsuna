/**
 * Deploys a production build of `oracle_router` (no demo price switch), locks it behind the policy
 * timelock and moves every vault whose owner key is held here onto it, except the Leverage vault,
 * which keeps the demo router for the crash scenario. Recorded as `oracleRouterStrict`; `oracleRouter`
 * stays the demo router.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { xdr } from "@stellar/stellar-sdk";
import { address, call, deployContract, fail, read, send, signer, symbol, testnet, u64, vec } from "./lib/stellar.js";
import { readTestnet, writeTestnet } from "./lib/testnet-deployment.js";

const REFLECTOR = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const CHAINLINK = "CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4";
const CHAINLINK_BTC = "01a0b4d920000332000000000000000000000000000000000000000000000000";
const WBTC = "CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI";
const TIMELOCK = 600n;

const admin = signer("LEASH_ADMIN_SECRET");
const keeper = signer("LEASH_KEEPER_SECRET");
const owners = new Map(["LEASH_ADMIN_SECRET", "LEASH_CREATOR_SECRET"].flatMap(name =>
  process.env[name] ? [[signer(name).publicKey(), signer(name)] as const] : []));

function feed(reflectorSymbol: string, chainlink?: string): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: symbol("chainlink"),
      val: chainlink ? xdr.ScVal.scvBytes(Buffer.from(chainlink, "hex")) : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({ key: symbol("reflector"), val: vec([symbol("Other"), symbol(reflectorSymbol)]) }),
  ]);
}

async function main(): Promise<void> {
  const record = readTestnet();
  const transactions = (record.transactions ??= {}) as Record<string, string>;
  const leverage = record.vaults.find(vault => vault.id === "leverage")?.address;
  if (!record.factory || !leverage) throw new Error("No factory or Leverage vault recorded");

  // The earlier strict router predates the timelock; only a locked one is reused.
  const locked = async (id: string | undefined) => !!id && await read<bigint | null>(admin, id, "timelock").catch(() => null) !== null;
  let router = record.oracleRouterStrict;
  if (!router || !await locked(router)) {
    const deployed = await deployContract(admin, "oracle_router", [
      address(admin.publicKey()), address(testnet.usdc), address(REFLECTOR), address(CHAINLINK),
    ]);
    router = deployed.id;
    transactions.oracleRouterStrictDeploy = deployed.txHash;
    for (const [name, asset, value] of [
      ["USDC", testnet.usdc, feed("USDC")],
      ["XLM", testnet.xlm, feed("XLM")],
      ["wBTC", WBTC, feed("BTC", CHAINLINK_BTC)],
    ] as const) {
      transactions[`oracleStrictFeed${name}`] = (await send(admin, call(router, "set_feed", [address(asset), value]))).txHash;
    }
    transactions.oracleStrictLock = (await send(admin, call(router, "lock", [u64(TIMELOCK)]))).txHash;
    record.oracleRouterStrict = router;
    writeTestnet(record);
    console.log(`STRICT_ROUTER ${router} demo=${await read<boolean>(admin, router, "is_demo")}`);
  }

  let latest = 0;
  const moving: string[] = [];
  for (const vault of await read<string[]>(admin, record.factory, "vaults")) {
    if (vault === leverage || await read<string>(admin, vault, "oracle") === router) continue;
    const owner = owners.get(await read<string>(admin, vault, "owner"));
    if (!owner) continue;
    const pending = await read<[string, bigint] | null>(admin, vault, "pending_oracle");
    if (!pending || pending[0] !== router) {
      const proposed = await send(owner, call(vault, "propose_oracle", [address(router)]));
      console.log(`STRICT_PROPOSED ${vault} ${proposed.txHash}`);
    }
    const eta = (await read<[string, bigint]>(admin, vault, "pending_oracle"))[1];
    latest = Math.max(latest, Number(eta));
    moving.push(vault);
  }
  for (let left = latest - Date.now() / 1000; moving.length > 0 && left > -10; left = latest - Date.now() / 1000) {
    console.log(`STRICT_TIMELOCK ${Math.ceil(left) + 10}s left`);
    await sleep(Math.min(60, left + 10) * 1000);
  }
  for (const vault of moving) {
    transactions[`oracleStrictSwitch:${vault}`] = (await send(keeper, call(vault, "apply_oracle", []))).txHash;
    console.log(`STRICT_SWITCHED ${vault}`);
  }
  writeTestnet(record);
}

main().catch(fail);
