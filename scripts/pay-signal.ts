import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Networks, rpc } from "@stellar/stellar-sdk";
import { buySignal, type BuySignalOptions, type SignalPurchase } from "../packages/agent/src/index.js";
import { deploySignalBudget, readDeployment, type PayDeployment } from "./deploy-signal-budget.js";
import { UNIT, address, balance, fail, read, server, signer, u32 } from "./lib/stellar.js";

const PORT = 3217;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PRICE = 2n * UNIT;

interface SpendingLimitData {
  spending_limit: bigint;
  period_ledgers: number;
  spending_history: { amount: bigint; ledger_sequence: number }[];
}

/** USDC already spent by the session rule inside the policy's rolling window. */
async function spentInWindow(deployment: PayDeployment): Promise<bigint> {
  const ops = signer("LEASH_PAY_OPS_SECRET");
  const data = await read<SpendingLimitData>(ops, deployment.policy, "get_spending_limit_data", [u32(1), address(deployment.signalBudget)]);
  const cutoff = (await server.getLatestLedger()).sequence - data.period_ledgers;
  return data.spending_history.filter(entry => entry.ledger_sequence > cutoff).reduce((sum, entry) => sum + entry.amount, 0n);
}

/**
 * The demo needs an untouched daily window (two payments fit under 5 USDC, the
 * third does not). A budget that already spent today is replaced by a fresh one.
 */
async function budgetWithEmptyWindow(): Promise<PayDeployment> {
  const current = await readDeployment();
  if (current && await spentInWindow(current) === 0n) return deploySignalBudget();
  if (current) console.log(`BUDGET_WINDOW_USED ${current.signalBudget}; deploying a fresh signal budget`);
  return deploySignalBudget({ fresh: Boolean(current) });
}

function startWeb(): ChildProcess {
  const child = spawn("pnpm", ["--dir", "web", "exec", "next", "dev", "--port", String(PORT), "--hostname", "127.0.0.1"], {
    stdio: ["ignore", "ignore", "inherit"], detached: true,
  });
  child.on("exit", code => { if (code) console.error(`web server exited with ${code}`); });
  return child;
}

function stopWeb(child: ChildProcess) {
  if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
}

async function waitForWeb(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/api/signals/rates`);
      if (response.status === 402) return;
    } catch {
      // Not listening yet.
    }
    await sleep(1000);
  }
  throw new Error("The web server did not serve /api/signals/rates in time");
}

async function assertLedgerStatus(hash: string, expected: rpc.Api.GetTransactionStatus) {
  const result = await server.getTransaction(hash);
  assert.equal(result.status, expected, `${hash} is ${result.status}, expected ${expected}`);
}

function paid(purchase: SignalPurchase) {
  assert(purchase.status === "paid", `Expected a paid ${purchase.kind} signal, got ${JSON.stringify(purchase)}`);
  return purchase;
}

async function main(): Promise<void> {
  const deployment = await budgetWithEmptyWindow();
  const ops = signer("LEASH_PAY_OPS_SECRET");
  const options: BuySignalOptions = {
    baseUrl: BASE_URL,
    budget: { account: deployment.signalBudget, verifier: deployment.verifier, sessionKey: signer("LEASH_AGENT_SECRET") },
    asset: deployment.usdc,
    maxPrice: PRICE,
    rpcServer: server,
    networkPassphrase: Networks.TESTNET,
    // The ops account pays the fee of the refused payment so it lands on-chain.
    refusalSubmitter: ops,
  };
  const budgetBefore = await balance(ops, deployment.signalBudget);
  const web = startWeb();
  try {
    await waitForWeb();
    const rates = paid(await buySignal("rates", options));
    assert.equal(rates.protocol, "x402");
    await assertLedgerStatus(rates.paymentTxHash, rpc.Api.GetTransactionStatus.SUCCESS);
    console.log(`X402_PAYMENT ${rates.paymentTxHash} SUCCESS data=${JSON.stringify(rates.data)}`);

    const risk = paid(await buySignal("risk", options));
    assert.equal(risk.protocol, "mpp");
    await assertLedgerStatus(risk.paymentTxHash, rpc.Api.GetTransactionStatus.SUCCESS);
    console.log(`MPP_PAYMENT ${risk.paymentTxHash} SUCCESS data=${JSON.stringify(risk.data)}`);

    const third = await buySignal("rates", options);
    assert(third.status === "refused", `The third payment must exceed the 5 USDC limit, got ${JSON.stringify(third)}`);
    assert.equal(third.reason, "SpendingLimitExceeded");
    assert.equal(third.code, 3221);
    assert(third.failedTxHash, "The refused payment must be recorded on-chain");
    await assertLedgerStatus(third.failedTxHash, rpc.Api.GetTransactionStatus.FAILED);
    console.log(`REFUSED ${third.failedTxHash} RPC=FAILED ${third.reason} code=${third.code}`);

    const spent = budgetBefore - await balance(ops, deployment.signalBudget);
    assert.equal(spent, 2n * PRICE, "Only the two settled payments may leave the budget");
    console.log(`PASS x402 and MPP payments settled from ${deployment.signalBudget}; third payment refused on-chain by the spending limit (spent ${spent} stroops)`);
  } finally {
    stopWeb(web);
  }
}

main().catch(fail);
