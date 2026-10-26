import "server-only";
import { TsunaRefusal, presets, type CallPreset, type LeaderboardRow, type Policy, type PolicyCall, type VaultSummary } from "@tsuna/sdk";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { publisherAccount } from "@/lib/fleet/create";
import { passkeyDeployment } from "@/lib/passkey/deployment";
import { sponsoredContracts } from "@/lib/sponsor/stellar";
import { decodeVaultEvent, type VaultEvent } from "./chain-events";
import { cached, tsuna, rpcServer, typedError } from "./client";
import { assetSymbol, contractName, deployments, isFeatured } from "./deployments";
import { sharesValue } from "./format";
import type {
  AgentRow, AgentsResponse, CallView, ExposureView, HoldingView, HoldingsResponse, PolicyView, PositionView, RoleView, SnapshotPoint, VaultDetail,
} from "./types";

const LIST_TTL = 20_000;
const DETAIL_TTL = 15_000;
const EVENTS_TTL = 10_000;
/** Points kept for a sparkline. */
const SPARKLINE_POINTS = 48;
const LIMIT_COUNT = 7;
const STRATEGY_IDS = ["prudent", "leverage", "liquidity"];
const NO_DEBT = 2n ** 126n;

const recordOf = (address: string) => deployments.vaults.find(vault => vault.address === address);
const routeId = (address: string) => recordOf(address)?.slug ?? address;

/** Keeps the first and last snapshots and an even spread in between. */
function downsample(points: SnapshotPoint[]): SnapshotPoint[] {
  if (points.length <= SPARKLINE_POINTS) return points;
  const step = (points.length - 1) / (SPARKLINE_POINTS - 1);
  return Array.from({ length: SPARKLINE_POINTS }, (_, i) => points[Math.round(i * step)] as SnapshotPoint);
}

function ruleCount(policy: Policy | null) {
  if (!policy) return null;
  const calls = policy.calls.length + Object.values(policy.roles ?? {}).reduce((sum, role) => sum + role.calls.length, 0);
  return { calls, limits: LIMIT_COUNT, total: calls + LIMIT_COUNT };
}

/** `(value - base) / base` in bps, to a thousandth of a bp, as the leaderboard scores it. */
const changeBps = (value: bigint, base: bigint) => Number((value - base) * 10_000_000n / base) / 1_000;

/**
 * Return and drawdown up to the live share price. Snapshots are only taken when the vault acts,
 * so between two calls the price keeps moving (a priced XLM position, accrued interest) while
 * the last snapshot stands still.
 */
function liveScore(board: LeaderboardRow | undefined, pps: bigint | undefined): { returnBps: number | null; worstDrawdownBps: number | null } {
  const first = board?.snapshots[0]?.pps;
  if (!board || !first || first <= 0n || pps === undefined || pps <= 0n) {
    return { returnBps: board?.returnBps ?? null, worstDrawdownBps: board?.worstDrawdownBps ?? null };
  }
  const peak = board.snapshots.reduce((max, snapshot) => snapshot.pps > max ? snapshot.pps : max, pps);
  return { returnBps: changeBps(pps, first), worstDrawdownBps: Math.max(board.worstDrawdownBps, -changeBps(pps, peak)) };
}

function row(summary: VaultSummary, policy: Policy | null, board: LeaderboardRow | undefined): AgentRow {
  const record = recordOf(summary.address);
  return {
    address: summary.address,
    id: routeId(summary.address),
    name: summary.name,
    featured: isFeatured(summary.address),
    strategyId: typeof record?.strategyId === "string" ? record.strategyId
      : record && STRATEGY_IDS.includes(record.id) ? record.id : null,
    strategy: summary.strategy,
    creator: summary.creator,
    nav: summary.nav?.toString() ?? null,
    pps: summary.pps?.toString() ?? null,
    navError: summary.navError ? typedError(summary.navError) : null,
    totalShares: summary.totalShares.toString(),
    paused: summary.paused,
    roles: summary.roles,
    assets: summary.assets,
    stablecoinOnly: summary.assets.length === 1 && summary.assets[0] === passkeyDeployment.usdc,
    rules: ruleCount(policy),
    ...liveScore(board, summary.pps ?? undefined),
    since: board?.since ?? null,
    snapshots: downsample(board?.snapshots.map(s => ({ ts: s.ts, pps: s.pps.toString() })) ?? []),
  };
}

/**
 * The demo vaults of `deployments/testnet.json` and the vaults published with Create (registered
 * by its creator account), with NAV, policy summary and leaderboard scores. Other factory vaults
 * (SDK, runtime and rehearsal test vaults) are left out of the list and its totals.
 */
export function listAgents(): Promise<AgentsResponse> {
  return cached("agents", LIST_TTL, async () => {
    const client = tsuna();
    const publisher = publisherAccount();
    const [all, board] = await Promise.all([client.vaults(), client.leaderboard()]);
    const summaries = all.filter(summary => isFeatured(summary.address) || (publisher !== null && summary.creator === publisher));
    const policies = await Promise.all(summaries.map(summary => client.vault(summary.address).findPolicy()));
    const rows = summaries.map((summary, i) => row(summary, policies[i] ?? null, board.find(entry => entry.vault === summary.address)));
    const ranked = [...rows].sort((a, b) => (b.returnBps ?? -Infinity) - (a.returnBps ?? -Infinity));
    const totalNav = rows.reduce((sum, entry) => sum + BigInt(entry.nav ?? "0"), 0n);
    return { rows: ranked, totalNav: totalNav.toString(), asOf: new Date().toISOString() };
  });
}

/** Address of the vault a route segment names (deployment slug or contract address). */
export async function resolveVaultId(id: string): Promise<string | null> {
  const record = deployments.vaults.find(vault => vault.slug === id || vault.id === id || vault.address === id);
  if (record) return record.address;
  const { rows } = await listAgents();
  return rows.find(entry => entry.address === id)?.address ?? null;
}

/**
 * Presets whose rule this call matches. Blend actions share one rule
 * (`submit_with_allowance` with checked requests), so several can match:
 * "Blend supply, withdraw, borrow, repay".
 */
function presetLabel(call: PolicyCall): string | null {
  const matches = Object.values(presets).filter((preset): preset is CallPreset =>
    preset.kind === "call" && preset.fn === call.fn && preset.args.join() === call.rule.args.join());
  const [first, ...rest] = matches;
  if (!first) return null;
  const protocol = first.label.split(" ")[0] ?? "";
  return [first.label, ...rest.map(preset => preset.label.startsWith(`${protocol} `) ? preset.label.slice(protocol.length + 1) : preset.label)].join(", ");
}

function callView(call: PolicyCall, adapters: { kind: string; protocol: string }[]): CallView {
  return {
    target: call.target,
    targetName: contractName(call.target, adapters),
    fn: call.fn,
    args: call.rule.args,
    maxLossBps: call.rule.max_loss_bps,
    approve: call.rule.approve,
    preset: presetLabel(call),
  };
}

/** Full state of one vault: positions, exposure, policy, roles and their live budgets. */
export function getVault(address: string): Promise<VaultDetail> {
  return cached(`vault:${address}`, DETAIL_TTL, async () => {
    const client = tsuna();
    const vault = client.vault(address);
    const [{ rows }, summary, policy, health, pending] = await Promise.all([
      listAgents(), client.summary(address), vault.findPolicy(), vault.healthFactor(),
      vault.pendingPolicy().catch(() => null),
    ]);
    const base = rows.find(entry => entry.address === address) ?? row(summary, policy, undefined);
    const positions = policy ? await vault.positions().catch((error: unknown) => {
      if (error instanceof TsunaRefusal) return [];
      throw error;
    }) : [];
    const roles = policy ? await vault.roles() : {};
    const now = Math.floor(Date.now() / 1000);
    const roleViews: RoleView[] = await Promise.all(Object.entries(roles).map(async ([name, role]) => {
      const [usage, loss] = await Promise.all([vault.usage(name).catch(() => null), vault.dailyLoss(name).catch(() => null)]);
      return {
        name,
        member: role.member,
        mode: role.mode,
        calls: role.calls.map(call => callView(call, summary.adapters)),
        quota: role.quota,
        usage: usage && {
          callsThisHour: usage.hour === BigInt(Math.floor(now / 3_600)) ? usage.calls : 0,
          spentToday: (usage.day === BigInt(Math.floor(now / 86_400)) ? usage.spent : 0n).toString(),
        },
        dailyLoss: loss?.toString() ?? null,
      };
    }));
    const nav = summary.nav ?? 0n;
    const byProtocol = new Map<string, bigint>();
    for (const position of positions) {
      if (position.protocol === "idle") continue;
      byProtocol.set(position.protocol, (byProtocol.get(position.protocol) ?? 0n) + position.value);
    }
    const exposure: ExposureView[] = [...byProtocol].map(([protocol, value]) => ({
      protocol,
      protocolName: contractName(protocol, summary.adapters),
      value: value.toString(),
      bps: nav > 0n ? Number(value * 10_000n / nav) : 0,
      capBps: policy?.exposure_caps?.[protocol] ?? policy?.limits.max_exposure_bps ?? 0,
    }));
    const decimals = new Map<string, number>();
    await Promise.all([...new Set(positions.map(p => p.asset))].map(async asset => {
      decimals.set(asset, asset === passkeyDeployment.usdc ? 7 : await client.read<number>(asset, "decimals").catch(() => 7));
    }));
    const positionViews: PositionView[] = positions.map(position => ({
      protocol: position.protocol,
      protocolName: contractName(position.protocol, summary.adapters),
      kind: position.kind,
      asset: position.asset,
      assetSymbol: assetSymbol(position.asset),
      amount: position.amount.toString(),
      assetDecimals: decimals.get(position.asset) ?? 7,
      value: position.value.toString(),
    }));
    const policyView: PolicyView | null = policy && {
      limits: policy.limits,
      assets: policy.assets.map(asset => ({ address: asset, symbol: assetSymbol(asset) })),
      protocols: policy.protocols.map(protocol => ({ address: protocol, name: contractName(protocol, summary.adapters) })),
      exposureCaps: Object.entries(policy.exposure_caps ?? {}).map(([protocol, bps]) => ({ protocol, name: contractName(protocol, summary.adapters), bps })),
      pendingEta: pending ? Number(pending.eta) : null,
    };
    const owner = await vault.owner();
    return {
      ...base,
      name: summary.name,
      nav: summary.nav?.toString() ?? null,
      pps: summary.pps?.toString() ?? null,
      navError: summary.navError ? typedError(summary.navError) : null,
      paused: summary.paused,
      totalShares: summary.totalShares.toString(),
      owner,
      session: summary.agent,
      healthFactorBps: health >= NO_DEBT ? null : health.toString(),
      positions: positionViews,
      exposure,
      policy: policyView,
      roleViews,
      sponsored: sponsoredContracts().has(address),
      runnable: deployments.vaults.some(vault => vault.address === address),
      asOf: new Date().toISOString(),
    };
  });
}

/** `getEvents` accepts 5 filters per request and 5 contract ids per filter. */
const IDS_PER_FILTER = 5;
const FILTERS_PER_REQUEST = 5;
const PAGE = 1_000;
const cursorLedger = (cursor: string) => Number(BigInt(cursor.split("-")[0] ?? "0") >> 32n);

interface EventLog {
  key: string;
  events: VaultEvent[];
  cursors: (string | null)[];
}

let log: EventLog | null = null;

async function scan(server: rpc.Server, filters: rpc.Api.EventFilter[], cursor: string | null, startLedger: number, into: VaultEvent[]): Promise<string> {
  let page = cursor
    ? await server.getEvents({ cursor, filters, limit: PAGE })
    : await server.getEvents({ startLedger, filters, limit: PAGE });
  for (;;) {
    for (const event of page.events) {
      const decoded = decodeVaultEvent(event);
      if (decoded) into.push(decoded);
    }
    if (page.events.length < PAGE && cursorLedger(page.cursor) >= page.latestLedger) return page.cursor;
    page = await server.getEvents({ cursor: page.cursor, filters, limit: PAGE });
  }
}

/**
 * Executions, deposits and withdrawals of every vault that the RPC still
 * retains (about 7 days on testnet). The first call scans the retention window;
 * later calls only follow the cursor.
 */
export function vaultEvents(): Promise<VaultEvent[]> {
  return cached("events", EVENTS_TTL, async () => {
    const server = rpcServer();
    const vaults = [...new Set([...await tsuna().vaultAddresses(), ...deployments.vaults.map(vault => vault.address)])].sort();
    const key = vaults.join();
    if (log?.key !== key) log = { key, events: [], cursors: [] };
    const current = log;
    const groups: rpc.Api.EventFilter[][] = [];
    for (let i = 0; i < vaults.length; i += IDS_PER_FILTER * FILTERS_PER_REQUEST) {
      const slice = vaults.slice(i, i + IDS_PER_FILTER * FILTERS_PER_REQUEST);
      const filters: rpc.Api.EventFilter[] = [];
      for (let j = 0; j < slice.length; j += IDS_PER_FILTER) filters.push({ type: "contract", contractIds: slice.slice(j, j + IDS_PER_FILTER) });
      groups.push(filters);
    }
    const { oldestLedger } = await server.getHealth();
    const fresh: VaultEvent[] = [];
    current.cursors = await Promise.all(groups.map((filters, i) => scan(server, filters, current.cursors[i] ?? null, oldestLedger, fresh)));
    const seen = new Set(current.events.map(event => `${event.hash}:${event.kind}:${event.vault}`));
    for (const event of fresh) {
      const id = `${event.hash}:${event.kind}:${event.vault}`;
      if (!seen.has(id)) {
        seen.add(id);
        current.events.push(event);
      }
    }
    current.events.sort((a, b) => a.ledger - b.ledger);
    return current.events;
  });
}

async function usdcBalance(user: string): Promise<bigint | null> {
  try {
    return await tsuna().read<bigint>(passkeyDeployment.usdc, "balance", [new Address(user).toScVal()]);
  } catch (error) {
    // A classic account without a USDC trustline cannot hold a balance.
    if (error instanceof TsunaRefusal) return null;
    throw error;
  }
}

/** Shares, value and net deposits of `user` in every vault, plus their USDC balance. */
export function getHoldings(user: string): Promise<HoldingsResponse> {
  return cached(`holdings:${user}`, DETAIL_TTL, async () => {
    const client = tsuna();
    const [{ rows }, events, balance, addresses] = await Promise.all([listAgents(), vaultEvents(), usdcBalance(user), client.vaultAddresses()]);
    const holdings = await Promise.all(addresses.map(async address => {
      const owned = await client.vault(address).sharesOf(user);
      const flows = events.filter(event => event.vault === address && event.kind !== "executed" && event.user === user);
      if (owned === 0n && flows.length === 0) return null;
      const entry = rows.find(entry => entry.address === address) ?? row(await client.summary(address), null, undefined);
      const net = flows.reduce((sum, event) => {
        if (event.kind === "deposited") return sum + BigInt(event.amount);
        if (event.kind === "withdrawn") return sum - BigInt(event.amount);
        return sum;
      }, 0n);
      const first = flows[0];
      return {
        vault: entry.address,
        id: entry.id,
        name: entry.name,
        shares: owned.toString(),
        value: entry.pps ? sharesValue(owned, entry.pps).toString() : "0",
        netDeposited: net.toString(),
        firstSeen: first ? Math.floor(new Date(first.at).getTime() / 1000) : null,
        paused: entry.paused,
        pps: entry.pps,
      } satisfies HoldingView;
    }));
    return { user, holdings: holdings.filter(holding => holding !== null), usdcBalance: balance?.toString() ?? null, asOf: new Date().toISOString() };
  });
}

/** Simulates `deposit`/`withdraw` for `user`: the typed refusal, or null when the vault accepts it. */
export async function preflight(address: string, action: "deposit" | "withdraw", user: string, amount: bigint) {
  const client = tsuna();
  try {
    await client.read(address, action, [new Address(user).toScVal(), nativeToScVal(amount, { type: "i128" })]);
    return null;
  } catch (error) {
    const decoded = client.decodeError(error);
    if (decoded) return typedError(decoded);
    throw error;
  }
}

