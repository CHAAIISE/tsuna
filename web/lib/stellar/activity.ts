import "server-only";
import { describeError } from "@tsuna/sdk";
import { rpc } from "@stellar/stellar-sdk";
import { decodeVaultCall, failureFromDiagnostics, type VaultCall } from "./chain-events";
import { HORIZON_URL, cached, tsuna, rpcServer, typedError } from "./client";
import { contractName, deployments, extraSources } from "./deployments";
import { readJournal } from "./journal-store";
import { mergeTimeline, type FailedAttempt } from "./timeline";
import type { ActivityResponse, TypedError } from "./types";
import { getVault, vaultEvents } from "./vaults";

const HORIZON_TTL = 15_000;
/** Most recent transactions read per account on Horizon (its page maximum). */
const HORIZON_PAGE = 200;
/** Failed calls decoded per vault (one RPC `getTransaction` each, cached by hash). */
const MAX_FAILED = 40;

interface HorizonTx {
  hash: string;
  successful: boolean;
  created_at: string;
  envelope_xdr: string;
  source_account: string;
}

/** Latest transactions of `account`, failed ones included. */
function accountTransactions(account: string): Promise<HorizonTx[]> {
  return cached(`horizon:${account}`, HORIZON_TTL, async () => {
    const url = `${HORIZON_URL}/accounts/${account}/transactions?include_failed=true&order=desc&limit=${HORIZON_PAGE}`;
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Horizon answered ${response.status} for ${account}`);
    const body = await response.json() as { _embedded: { records: HorizonTx[] } };
    return body._embedded.records;
  });
}

const HOST_MESSAGES: Record<string, string> = {
  Auth: "An authorization was missing or its signature did not verify.",
  Budget: "The transaction ran out of its CPU or memory budget.",
  Storage: "The transaction touched ledger state outside its footprint, or missing state.",
};

const failures = new Map<string, TypedError | null>();

/** Typed error of a FAILED transaction, from its diagnostic events (immutable, cached by hash). */
async function failureOf(hash: string): Promise<TypedError | null> {
  if (failures.has(hash)) return failures.get(hash) ?? null;
  const result = await rpcServer().getTransaction(hash);
  // Outside the RPC's retention the error is no longer readable; the hash still is.
  if (result.status !== rpc.Api.GetTransactionStatus.FAILED) return null;
  const raw = failureFromDiagnostics(result.diagnosticEventsXdr ?? []);
  const error: TypedError | null = !raw ? null
    : raw.kind === "contract"
      ? typedError(describeError(raw.contractId ? tsuna().classify(raw.contractId) : "vault", raw.code))
      : {
        contract: "other", code: 0, name: raw.type === "Auth" ? "AuthFailed" : `Host${raw.type}Error`,
        message: HOST_MESSAGES[raw.type] ?? `The Soroban host failed with a ${raw.type} error.`,
      };
  failures.set(hash, error);
  return error;
}

/**
 * Refused vault calls recorded on-chain. A refusal reverts the vault's events,
 * so they are found from the transactions of the accounts that sign or pay for
 * vault calls (role members, known fee payers, the demo attacker) on Horizon,
 * then decoded from the RPC's diagnostic events.
 */
async function failedAttempts(vault: string, members: string[]): Promise<FailedAttempt[]> {
  const sources = [...new Set([...members, ...extraSources, process.env.LEASH_ATTACKER_PUBLIC ?? ""].filter(Boolean))];
  const lists = await Promise.all(sources.map(account => accountTransactions(account).catch(() => [])));
  const seen = new Set<string>();
  const candidates: (HorizonTx & { call: VaultCall })[] = [];
  for (const tx of lists.flat()) {
    if (tx.successful || seen.has(tx.hash)) continue;
    seen.add(tx.hash);
    const call = decodeVaultCall(tx.envelope_xdr, tsuna().networkPassphrase);
    if (call?.vault === vault) candidates.push({ ...tx, call });
  }
  candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return Promise.all(candidates.slice(0, MAX_FAILED).map(async tx => ({
    hash: tx.hash,
    signer: tx.source_account,
    at: tx.created_at,
    role: tx.call.role,
    target: tx.call.target,
    fn: tx.call.fn,
    error: await failureOf(tx.hash).catch(() => null),
  })));
}

/** Agent journal, refused attempts, executions, deposits and withdrawals of `vault`, newest first. */
export function getActivity(vault: string): Promise<ActivityResponse> {
  return cached(`activity:${vault}`, 8_000, async () => {
    const detail = await getVault(vault);
    const members = detail.roleViews.map(role => role.member);
    const [events, failed, journal] = await Promise.all([
      vaultEvents().then(all => all.filter(event => event.vault === vault)),
      failedAttempts(vault, members),
      readJournal(vault),
    ]);
    const adapters = deployments.vaults.find(entry => entry.address === vault)?.adapters ?? [];
    const attacker = process.env.LEASH_ATTACKER_PUBLIC;
    const items = mergeTimeline({ journal, events, failed, name: contract => contractName(contract, adapters), ...(attacker ? { attacker } : {}) });
    return { items, sources: { events: true, failedTxs: true, journal: journal.length > 0 }, asOf: new Date().toISOString() };
  });
}
