import { Account, BASE_FEE, Contract, TransactionBuilder, rpc, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, rpcServer } from "./config";

/** Simulation-only source: read calls never reach the ledger, so no funded account is needed. */
const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Calls a read-only contract function through simulation and returns its native value with the ledger read. */
export async function readContract<T>(contract: string, fn: string, args: xdr.ScVal[] = []): Promise<{ value: T; ledger: number }> {
  const tx = new TransactionBuilder(new Account(READ_SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const simulation = await rpcServer.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${fn} on ${contract} failed: ${rpc.Api.isSimulationError(simulation) ? simulation.error : "no result"}`);
  }
  return { value: scValToNative(simulation.result.retval) as T, ledger: simulation.latestLedger };
}
