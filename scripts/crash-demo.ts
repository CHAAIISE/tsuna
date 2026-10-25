/**
 * Crash scenario on the demo Leverage vault (testnet): the demo oracle drops XLM by 30 %, the
 * yield agent is refused `HealthFactorTooLow`, the keeper's `check_drawdown` pauses the vault,
 * the risk-off role is refused `RiskIncreased` when it tries to borrow, the risk-off agent repays
 * Blend debt while paused, and Alice withdraws. Every step is a real transaction read back with
 * `getTransaction`. The price, the pause and the Blend book are restored at the end so the
 * scenario can run again.
 */
import { LEVERAGE_MAX_DRAWDOWN_BPS, UNIT, fail, signer } from "./lib/stellar.js";
import { ensureBlendUsdc } from "./lib/pay.js";
import { Address, Contract, Keypair, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  Leash, TESTNET, actions, explorerTx, loadDeployments, type Call, type ExecuteOptions, type Position, type TxResult,
} from "../packages/sdk/src/index.js";
import { runAgent } from "../packages/agent/src/runtime/run.js";
import type { JournalEntry } from "../packages/agent/src/runtime/journal.js";

const VAULT_ID = "leverage";
const RISKOFF = "riskoff";
const CRASH_BPS = 3_000n;
const BPS = 10_000n;
/** Health factor the refused borrow aims for at the crashed price: under the 1.3 floor, above 1. */
const REFUSED_BORROW_HF_BPS = 12_000n;
/** Smallest Blend request used as a valid sibling call for footprints, and the dust a restore ignores. */
const DUST = UNIT / 100n;
const ALICE_DEPOSIT = UNIT;
const AGENT_ATTEMPTS = 2;

const deployments = loadDeployments();
const leash = new Leash({ deployments });
const found = deployments.vaults.find(v => v.id === VAULT_ID);
if (!found) throw new Error(`Vault ${VAULT_ID} is not in the deployments file`);
const record = found;
const vault = leash.vault(record.address);
const routerId = deployments.oracleRouter;
if (!routerId) throw new Error("No oracle router in the deployments file");
const router = routerId;

const admin = signer("LEASH_ADMIN_SECRET");
const agent = signer("LEASH_AGENT_SECRET");
const keeper = signer("LEASH_KEEPER_SECRET");
const riskoff = signer("LEASH_RISKOFF_SECRET");
const alice = signer("E2E_USER_SECRET");

const amount = (stroops: bigint) => {
  const sign = stroops < 0n ? "-" : "";
  const abs = stroops < 0n ? -stroops : stroops;
  return `${sign}${abs / UNIT}.${(abs % UNIT).toString().padStart(7, "0")}`;
};
const hf = (bps: bigint) => (bps > 1_000_000_000n ? "none (no debt)" : (Number(bps) / 10_000).toFixed(4));
const address = (value: string) => new Address(value).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

/** Reads `hash` back from the RPC and fails unless it landed with `expected`. */
async function confirm(label: string, tx: TxResult, expected: TxResult["status"], error?: string): Promise<string> {
  const onChain = await leash.server.getTransaction(tx.hash);
  const name = tx.error?.name;
  console.log(`${label} ${onChain.status}${name ? ` ${name}` : ""} ${tx.hash} ${explorerTx(tx.hash)}`);
  if (onChain.status !== expected || tx.status !== expected) {
    throw new Error(`${label}: expected ${expected}, chain says ${onChain.status} (${tx.hash})`);
  }
  if (error && name !== error) throw new Error(`${label}: expected ${error}, got ${name ?? "no error"} (${tx.hash})`);
  return tx.hash;
}

const routerCall = (fn: string, args: xdr.ScVal[] = []) =>
  leash.chain.invoke(admin, new Contract(router).call(fn, ...args), [admin], "oracle");

/** Forced demo price of `asset` stored on the router, read from its ledger entry. */
async function forcedPrice(asset: string): Promise<bigint | null> {
  const key = xdr.ScVal.scvVec([nativeToScVal("Price", { type: "symbol" }), address(asset)]);
  let entry: rpc.Api.LedgerEntryResult;
  try {
    entry = await leash.server.getContractData(router, key, rpc.Durability.Persistent);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 404) return null;
    throw error;
  }
  const data = entry.val;
  if (data.type !== "contractData") throw new Error("Unexpected ledger entry for the forced price");
  return scValToNative(data.contractData.val) as bigint;
}

const sum = (positions: Position[], match: (p: Position) => boolean, field: "amount" | "value") =>
  positions.filter(match).reduce((total, p) => total + p[field], 0n);

interface Book { debt: bigint; collateral: bigint; idleXlm: bigint; xlmValue: bigint }

async function book(): Promise<Book> {
  const positions = await vault.positions();
  return {
    debt: -sum(positions, p => p.kind === "debt" && p.asset === TESTNET.usdc, "amount"),
    collateral: sum(positions, p => p.kind === "collateral" && p.asset === TESTNET.xlm, "amount"),
    idleXlm: sum(positions, p => p.kind === "idle" && p.asset === TESTNET.xlm, "amount"),
    xlmValue: sum(positions, p => p.asset === TESTNET.xlm, "value"),
  };
}

/**
 * Submits a call the vault must refuse with `error`: simulation has to refuse it first, then it is
 * sent anyway so the refusal is recorded on-chain.
 */
async function refused(label: string, member: Keypair, call: Call, error: string, opts: ExecuteOptions): Promise<string> {
  const simulated = await vault.simulateExecute(member, call, opts.role ? { role: opts.role } : {});
  if (simulated.ok) throw new Error(`${label}: the vault accepted ${call.fn} in simulation; not submitted`);
  if (simulated.error.name !== error) throw new Error(`${label}: simulation refused with ${simulated.error.name}, expected ${error}`);
  return confirm(label, await vault.execute(member, call, { ...opts, submitEvenIfRefused: true }), "FAILED", error);
}

const printEntry = (entry: JournalEntry) => {
  const detail = entry.kind === "model"
    ? entry.text
    : [entry.input, entry.output, entry.error, ...(entry.simulation ?? []).map(s => (s.ok ? "sim ok" : `sim ${s.error}`)),
      ...(entry.tx ?? []).map(t => `${t.status}${t.error ? ` ${t.error}` : ""} ${t.hash}`)].filter(Boolean).join(" | ");
  console.log(`  [risk-off agent] ${entry.tool ?? "model"}: ${(detail ?? "").replace(/\s+/g, " ").slice(0, 240)}`);
};

const hashes: Record<string, string> = {};
const restoreHashes: string[] = [];
let failed = false;
let demoEnabledHere = false;
let crashed = false;
let startBook: Book | null = null;

async function scenario(): Promise<void> {
  console.log(`VAULT ${record.name} ${vault.address}`);
  if (await vault.paused()) {
    throw new Error("The vault is already paused (drawdown or protocol watch): resolve that pause before running the crash");
  }

  // Demo mode and a clean XLM price, so "before" is the price the sources give.
  if (!await leash.read<boolean>(router, "is_demo")) {
    const enabled = await routerCall("set_demo", [xdr.ScVal.scvBool(true)]);
    await confirm("DEMO_MODE_ON", enabled, "SUCCESS");
    demoEnabledHere = true;
  }
  const leftover = await forcedPrice(TESTNET.xlm);
  if (leftover !== null) {
    console.log(`LEFTOVER_FORCED_PRICE XLM ${amount(leftover)} USDC from an earlier run`);
    await confirm("LEFTOVER_PRICE_CLEARED", await routerCall("clear_demo_price", [address(TESTNET.xlm)]), "SUCCESS");
  }

  // Alice holds shares before the crash.
  if (await vault.sharesOf(alice.publicKey()) === 0n) {
    await ensureBlendUsdc(alice, ALICE_DEPOSIT);
    const deposited = await vault.deposit(alice, ALICE_DEPOSIT);
    hashes.aliceDeposit = await confirm(`ALICE_DEPOSIT ${amount(ALICE_DEPOSIT)} USDC`, deposited, "SUCCESS");
  }
  console.log(`ALICE_SHARES ${await vault.sharesOf(alice.publicKey())}`);

  // Drawdown breaker sized to the vault's XLM book.
  const policy = await vault.policy();
  const limit = policy.limits.max_drawdown_bps;
  if (limit > LEVERAGE_MAX_DRAWDOWN_BPS) {
    const tightened = await leash.proposePolicy(admin, vault.address, {
      ...policy, limits: { ...policy.limits, max_drawdown_bps: LEVERAGE_MAX_DRAWDOWN_BPS },
    });
    hashes.drawdownLimit = await confirm(`DRAWDOWN_LIMIT ${limit} -> ${LEVERAGE_MAX_DRAWDOWN_BPS} bps`, tightened, "SUCCESS");
    const inForce = (await vault.policy()).limits.max_drawdown_bps;
    if (inForce !== LEVERAGE_MAX_DRAWDOWN_BPS) throw new Error(`The registry did not apply the tighter drawdown (${inForce} bps in force)`);
  } else {
    console.log(`DRAWDOWN_LIMIT ${limit} bps in force (target ${LEVERAGE_MAX_DRAWDOWN_BPS} bps)`);
  }
  const maxDrawdown = BigInt((await vault.policy()).limits.max_drawdown_bps);
  const minHealth = BigInt(policy.limits.min_health_factor_bps);

  startBook = await book();
  const [nav, priceBefore, healthBefore] = await Promise.all([vault.nav(), leash.price(TESTNET.xlm), vault.healthFactor()]);
  if (startBook.debt < DUST) throw new Error(`The vault has no Blend debt to de-risk (${amount(startBook.debt)} USDC)`);
  const expectedDrop = startBook.xlmValue * CRASH_BPS / nav;
  console.log(`BOOK nav=${amount(nav)} USDC xlm_book=${amount(startBook.xlmValue)} USDC debt=${amount(startBook.debt)} USDC health=${hf(healthBefore)}`);
  console.log(`EXPECTED_PPS_DROP ${expectedDrop} bps at -${CRASH_BPS / 100n} % XLM; max_drawdown=${maxDrawdown} bps`);
  if (expectedDrop <= maxDrawdown) {
    throw new Error(`A -${CRASH_BPS / 100n} % XLM crash moves price per share by ${expectedDrop} bps, inside the ${maxDrawdown} bps breaker`);
  }

  // Baseline: the vault is within its breaker before the crash, and this snapshot is the peak.
  const baseline = await vault.checkDrawdown(keeper);
  hashes.baseline = await confirm("BASELINE_CHECK_DRAWDOWN", baseline, "SUCCESS");
  if (await vault.paused()) throw new Error("check_drawdown paused the vault before the crash: price per share already sits below its 24 h peak");

  // 1. Crash.
  const crashPrice = priceBefore * (BPS - CRASH_BPS) / BPS;
  crashed = true;
  hashes.crash = await confirm("CRASH_SET_DEMO_PRICE", await routerCall("set_demo_price", [address(TESTNET.xlm), i128(crashPrice)]), "SUCCESS");
  const [priceAfter, healthAfter] = await Promise.all([leash.price(TESTNET.xlm), vault.healthFactor()]);
  if (priceAfter !== crashPrice) throw new Error(`price_strict reads ${priceAfter}, expected the forced ${crashPrice}`);
  console.log(`XLM_PRICE before=${amount(priceBefore)} after=${amount(priceAfter)} USDC (-${CRASH_BPS / 100n} %)`);
  console.log(`HEALTH_FACTOR before=${hf(healthBefore)} after=${hf(healthAfter)} floor=${hf(minHealth)}`);

  // 2. Yield agent borrows more: refused by the health factor floor.
  if (healthAfter <= minHealth) throw new Error("The crash already put the health factor under the floor; no valid sibling call to budget the refusal");
  const debt = (await book()).debt;
  const sized = debt * healthAfter / REFUSED_BORROW_HF_BPS - debt;
  const borrow = sized > DUST ? sized : DUST;
  console.log(`YIELD_AGENT blend_borrow ${amount(borrow)} USDC (health factor ${hf(healthAfter)} -> ~${hf(healthAfter * debt / (debt + borrow))})`);
  hashes.hfRefusal = await refused("HF_REFUSAL", agent, actions.blendBorrow(vault.address, TESTNET.usdc, borrow)[0] as Call, "HealthFactorTooLow", {
    footprintFrom: actions.blendBorrow(vault.address, TESTNET.usdc, DUST)[0] as Call,
  });

  // 3. Keeper: permissionless drawdown check pauses the vault.
  const pps = await vault.pricePerShare();
  const check = await vault.checkDrawdown(keeper);
  hashes.pause = await confirm("KEEPER_CHECK_DRAWDOWN", check, "SUCCESS");
  const paused = await vault.paused();
  console.log(`PAUSED ${paused} (price per share ${pps}, returned ${check.returnValue ? String(scValToNative(check.returnValue)) : "?"})`);
  if (!paused) throw new Error("check_drawdown did not pause the vault after the crash");

  // 4. Risk-off role tries to borrow while paused: refused on its outcome. It runs before the
  // repay because a refused borrow is budgeted from a valid repay of the same reserve, which needs
  // debt left to repay.
  // Only a borrow makes Blend price the whole account through its oracle, and every borrow is
  // refused to this role: those reads come from read-only calls instead.
  const { oracle } = await leash.read<{ oracle: string }>(TESTNET.blendPool, "get_config");
  const blendOracle = new Contract(oracle);
  const pool = new Contract(TESTNET.blendPool);
  const footprintOps = [
    blendOracle.call("decimals"),
    ...[TESTNET.xlm, TESTNET.usdc].flatMap(asset => [
      blendOracle.call("lastprice", xdr.ScVal.scvVec([nativeToScVal("Stellar", { type: "symbol" }), address(asset)])),
      pool.call("get_reserve", address(asset)),
    ]),
  ];
  console.log(`RISKOFF_ROLE blend_borrow ${amount(borrow)} USDC via execute_as`);
  hashes.riskIncreased = await refused("RISK_INCREASED_REFUSAL", riskoff, actions.blendBorrow(vault.address, TESTNET.usdc, borrow)[0] as Call,
    "RiskIncreased", { role: RISKOFF, footprintFrom: actions.blendRepay(vault.address, TESTNET.usdc, DUST)[0] as Call, footprintOps });

  // 5. Risk-off agent repays Blend debt while paused.
  const debtBeforeRepay = (await book()).debt;
  for (let attempt = 1; attempt <= AGENT_ATTEMPTS && !hashes.riskoffRepay; attempt++) {
    console.log(`RISKOFF_AGENT run ${attempt}/${AGENT_ATTEMPTS}`);
    const run = await runAgent({
      vault: VAULT_ID,
      role: RISKOFF,
      deployments,
      prompt: `Situation: XLM fell ${CRASH_BPS / 100n} % on the vault's oracle and the keeper paused the vault on its drawdown breaker. Reduce the vault's risk now.`,
      onEntry: printEntry,
    });
    const repay = run.journal.find(entry => entry.tool === "propose_execute" && entry.input?.startsWith("blend_repay")
      && entry.tx?.some(tx => tx.status === "SUCCESS"));
    const tx = repay?.tx?.find(t => t.status === "SUCCESS");
    if (repay && tx) {
      hashes.riskoffRepay = await confirm(`RISKOFF_REPAY ${repay.input}`, { hash: tx.hash, status: tx.status }, "SUCCESS");
    } else {
      console.log(`RISKOFF_AGENT run ${attempt} submitted no successful blend_repay (${run.transactions.length} transaction(s))`);
    }
  }
  if (!hashes.riskoffRepay) throw new Error(`The risk-off agent did not repay Blend debt in ${AGENT_ATTEMPTS} runs`);
  const debtAfterRepay = (await book()).debt;
  console.log(`DEBT before=${amount(debtBeforeRepay)} after=${amount(debtAfterRepay)} USDC health=${hf(await vault.healthFactor())}`);
  if (debtAfterRepay >= debtBeforeRepay) throw new Error("Blend debt did not decrease");

  // 6. Alice withdraws while paused.
  const shares = await vault.sharesOf(alice.publicKey());
  const withdrawn = await vault.withdraw(alice, shares);
  hashes.aliceWithdraw = await confirm(`ALICE_WITHDRAW ${shares} shares`, withdrawn, "SUCCESS");
  const paid = withdrawn.returnValue ? scValToNative(withdrawn.returnValue) as bigint : 0n;
  console.log(`ALICE_PAID ${amount(paid)} USDC, shares left ${await vault.sharesOf(alice.publicKey())}, vault paused ${await vault.paused()}`);
}

/** Puts the price, the pause and the Blend book back as they were before the run. */
async function restore(): Promise<void> {
  const step = async (label: string, run: () => Promise<TxResult>) => {
    try {
      restoreHashes.push(await confirm(label, await run(), "SUCCESS"));
    } catch (error) {
      failed = true;
      console.error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (crashed || await forcedPrice(TESTNET.xlm) !== null) {
    await step("RESTORE_CLEAR_DEMO_PRICE", () => routerCall("clear_demo_price", [address(TESTNET.xlm)]));
    console.log(`XLM_PRICE restored ${amount(await leash.price(TESTNET.xlm))} USDC`);
  }
  if (demoEnabledHere) await step("RESTORE_DEMO_MODE_OFF", () => routerCall("set_demo", [xdr.ScVal.scvBool(false)]));
  if (await vault.paused()) await step("RESTORE_UNPAUSE", () => leash.chain.invoke(admin, new Contract(vault.address).call("set_paused", xdr.ScVal.scvBool(false)), [admin], "vault"));
  if (await vault.paused()) return;

  if (startBook) {
    const now = await book();
    if (now.idleXlm > DUST && now.collateral + DUST < startBook.collateral) {
      const supply = startBook.collateral - now.collateral < now.idleXlm ? startBook.collateral - now.collateral : now.idleXlm;
      await step(`RESTORE_COLLATERAL ${amount(supply)} XLM`, () =>
        vault.execute(agent, actions.blendSupplyCollateral(vault.address, TESTNET.xlm, supply)[0] as Call));
    }
    if (now.debt + DUST < startBook.debt) {
      const reborrow = startBook.debt - now.debt;
      await step(`RESTORE_DEBT ${amount(reborrow)} USDC`, () =>
        vault.execute(agent, actions.blendBorrow(vault.address, TESTNET.usdc, reborrow)[0] as Call));
    }
    console.log(`BOOK restored debt=${amount((await book()).debt)} USDC health=${hf(await vault.healthFactor())}`);
  }

  // The 24 h peak still holds the pre-crash price per share: with the price back, it must not re-pause.
  await step("RESTORE_CHECK_DRAWDOWN", () => vault.checkDrawdown(keeper));
  if (await vault.paused()) {
    failed = true;
    console.error("check_drawdown re-paused the vault after the restore");
    await step("RESTORE_UNPAUSE_AGAIN", () => leash.chain.invoke(admin, new Contract(vault.address).call("set_paused", xdr.ScVal.scvBool(false)), [admin], "vault"));
  } else {
    console.log("RECHECK not paused: price per share is back within the breaker");
  }
}

try {
  await scenario();
} catch (error) {
  failed = true;
  fail(error);
} finally {
  await restore().catch((error: unknown) => {
    failed = true;
    fail(error);
  });
}

console.log("\nSUMMARY");
for (const [name, hash] of Object.entries(hashes)) console.log(`  ${name} ${hash}`);
for (const hash of restoreHashes) console.log(`  restore ${hash}`);
console.log(failed ? "CRASH_DEMO FAILED" : "CRASH_DEMO OK");
process.exitCode = failed ? 1 : 0;
