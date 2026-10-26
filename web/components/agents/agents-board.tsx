"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, CircleAlert, Plus, Search } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-layout";
import { useAgents } from "@/lib/hooks/use-agents";
import { usePasskeyAccount } from "@/lib/hooks/use-passkey-account";
import { useHoldings } from "@/lib/hooks/use-vault";
import { formatAge, formatSharePrice, formatUsdc, shortAddress } from "@/lib/stellar/format";
import type { AgentRow, HoldingView } from "@/lib/stellar/types";
import { RulesBadge } from "./rules-badge";
import { DrawdownValue, ReturnValue } from "./metric";
import { Sparkline } from "./sparkline";

type StrategyFilter = "all" | "prudent" | "leverage" | "liquidity" | "other";
type AssetFilter = "all" | "stable" | "volatile";
type SortKey = "return" | "tvl" | "age";

const STRATEGIES: { id: StrategyFilter; label: string }[] = [
  { id: "all", label: "All" }, { id: "prudent", label: "Prudent" }, { id: "leverage", label: "Leverage" },
  { id: "liquidity", label: "Liquidity" }, { id: "other", label: "Other" },
];
const ASSETS: { id: AssetFilter; label: string }[] = [
  { id: "all", label: "Any asset" }, { id: "stable", label: "Stablecoin only" }, { id: "volatile", label: "Volatile assets" },
];
const NAMED_STRATEGIES = ["prudent", "leverage", "liquidity"];

const tvl = (row: AgentRow) => BigInt(row.nav ?? "0");

function FilterPills<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex w-fit max-w-full shrink-0 gap-1 overflow-x-auto rounded-full bg-secondary p-1 text-caption">
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn("rounded-full border border-transparent px-3 py-1.5 whitespace-nowrap transition-colors hover:text-foreground", value === option.id ? "border-input bg-card text-foreground shadow-card" : "text-muted-foreground")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SortHeader({ label, sortKey, sort, onSort, className }: { label: string; sortKey: SortKey; sort: SortKey; onSort: (key: SortKey) => void; className?: string }) {
  const active = sort === sortKey;
  return (
    <th scope="col" aria-sort={active ? "descending" : "none"} className={cn("px-3 py-3 font-normal", className)}>
      <button type="button" onClick={() => onSort(sortKey)} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
        {label}{active && <ArrowDown aria-hidden="true" className="size-3" />}
      </button>
    </th>
  );
}

function YourDeposit({ holding, signedIn }: { holding: HoldingView | undefined; signedIn: boolean }) {
  if (!signedIn) return <span className="text-muted-foreground">—</span>;
  return <span className="tabular-nums">{formatUsdc(holding?.value ?? "0")}</span>;
}

function AgentName({ row }: { row: AgentRow }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2 font-medium">
        <Link href={`/agents/${row.id}`} className="truncate after:absolute after:inset-0 hover:text-primary">{row.name}</Link>
        {row.paused && <span className="rounded-full bg-destructive-soft px-2 py-0.5 text-caption text-destructive">Paused</span>}
      </span>
      <span className="truncate text-caption text-muted-foreground">{row.strategyId ? `${row.strategyId[0]?.toUpperCase()}${row.strategyId.slice(1)} strategy` : "Custom policy"} · {row.stablecoinOnly ? "USDC only" : `${row.assets.length} assets`}</span>
    </span>
  );
}

function AgentTable({ title, rows, holdings, signedIn, sort, onSort, empty }: {
  title: string; rows: AgentRow[]; holdings: Map<string, HoldingView>; signedIn: boolean; sort: SortKey; onSort: (key: SortKey) => void;
  /** Shown under the title when there are no rows; without it, an empty table is not rendered. */
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    if (!empty) return null;
    return (
      <section aria-label={title}>
        <h2 className="px-6 pt-6 pb-2 text-subheading font-medium">{title}</h2>
        {empty}
      </section>
    );
  }
  return (
    <section aria-label={title}>
      <h2 className="px-6 pt-6 pb-2 text-subheading font-medium">{title}</h2>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[1080px] table-fixed text-left text-table" data-testid="agents-table">
          <colgroup>
            {["22%", "9%", "9%", "10%", "13%", "9%", "6%", "10%", "12%"].map((width, i) => <col key={i} style={{ width }} />)}
          </colgroup>
          <thead className="border-b text-caption text-muted-foreground">
            <tr>
              <th scope="col" className="py-3 pr-3 pl-6 font-normal">Agent</th>
              <th scope="col" className="px-3 py-3 font-normal">Creator</th>
              <SortHeader label="Return" sortKey="return" sort={sort} onSort={onSort} />
              <th scope="col" className="px-3 py-3 font-normal whitespace-nowrap" title="Largest fall of the share price from a previous peak">Worst drawdown</th>
              <SortHeader label="TVL" sortKey="tvl" sort={sort} onSort={onSort} />
              <th scope="col" className="px-3 py-3 font-normal">Your deposit</th>
              <SortHeader label="Age" sortKey="age" sort={sort} onSort={onSort} />
              <th scope="col" className="px-3 py-3 font-normal">Snapshot</th>
              <th scope="col" className="py-3 pr-6 pl-3 font-normal">Rules</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr
                key={row.address}
                data-testid="agent-row"
                data-vault={row.address}
                className="group relative h-table-row border-b transition-colors last:border-0 hover:bg-secondary"
              >
                <td className="py-3 pr-3 pl-6"><AgentName row={row} /></td>
                <td className="px-3 py-3 whitespace-nowrap text-muted-foreground" title={row.creator}>{shortAddress(row.creator)}</td>
                <td className="px-3 py-3"><ReturnValue bps={row.returnBps} /></td>
                <td className="px-3 py-3"><DrawdownValue bps={row.worstDrawdownBps} /></td>
                <td className="px-3 py-3">
                  <span className="flex flex-col items-start gap-1">
                    <span className="tabular-nums" data-testid="agent-tvl">{row.nav === null ? "Unpriced" : `${formatUsdc(row.nav)} USDC`}</span>
                    {row.pps && <span className="rounded-sm bg-chip px-1.5 py-0.5 text-caption text-muted-foreground tabular-nums">{formatSharePrice(row.pps)} / share</span>}
                  </span>
                </td>
                <td className="px-3 py-3"><YourDeposit holding={holdings.get(row.address)} signedIn={signedIn} /></td>
                <td className="px-3 py-3 text-muted-foreground tabular-nums" title="Since the first NAV snapshot the RPC still retains (about 7 days)">{row.since ? formatAge(row.since) : "—"}</td>
                <td className="px-3 py-3"><Sparkline points={row.snapshots} label={`${row.name} share price`} /></td>
                <td className="py-3 pr-6 pl-3">
                  <span className="flex items-center justify-between gap-3">
                    <RulesBadge rules={row.rules} />
                    {signedIn && (
                      <Button asChild size="sm" variant="outline" className="relative z-10 hidden group-hover:inline-flex group-focus-within:inline-flex">
                        <Link href={`/agents/${row.id}#deposit`}>Deposit</Link>
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y md:hidden">
        {rows.map(row => (
          <li key={row.address} data-testid="agent-card" className="relative space-y-3 px-4 py-4 hover:bg-secondary">
            <div className="flex items-start justify-between gap-3"><AgentName row={row} /><ReturnValue bps={row.returnBps} className="text-base font-medium" /></div>
            <dl className="grid grid-cols-3 gap-3 text-caption">
              <div><dt className="text-muted-foreground">TVL</dt><dd className="tabular-nums">{row.nav === null ? "Unpriced" : formatUsdc(row.nav)}</dd></div>
              <div><dt className="text-muted-foreground">Drawdown</dt><dd><DrawdownValue bps={row.worstDrawdownBps} /></dd></div>
              <div><dt className="text-muted-foreground">Age</dt><dd className="tabular-nums">{row.since ? formatAge(row.since) : "—"}</dd></div>
            </dl>
            <div className="flex items-center justify-between gap-3"><Sparkline points={row.snapshots} label={`${row.name} share price`} /><RulesBadge rules={row.rules} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SkeletonRows() {
  return (
    <div aria-label="Loading agents" role="status" className="space-y-0 px-6 py-4">
      {[0, 1, 2].map(i => (
        <div key={i} className="flex h-table-row items-center gap-6 border-b last:border-0">
          <div className="h-4 w-40 animate-pulse rounded bg-secondary" />
          <div className="hidden h-4 w-20 animate-pulse rounded bg-secondary md:block" />
          <div className="h-4 w-16 animate-pulse rounded bg-secondary" />
          <div className="hidden h-4 w-28 animate-pulse rounded bg-secondary md:block" />
          <div className="ml-auto h-6 w-24 animate-pulse rounded bg-secondary" />
        </div>
      ))}
      <p className="pt-3 text-caption text-muted-foreground">Reading vaults from Stellar…</p>
    </div>
  );
}

/** The leaderboard: the demo vaults and those published with Create, scored from their on-chain `NavSnapshot` events. */
export function AgentsBoard() {
  const { data, error, isPending, refetch, isFetching } = useAgents();
  const { account } = usePasskeyAccount();
  const holdingsQuery = useHoldings(account?.account ?? null);
  const [strategy, setStrategy] = useState<StrategyFilter>("all");
  const [assets, setAssets] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("return");

  const holdings = useMemo(() => new Map((holdingsQuery.data?.holdings ?? []).map(holding => [holding.vault, holding])), [holdingsQuery.data]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = (data?.rows ?? []).filter(row => {
      const known = row.strategyId !== null && NAMED_STRATEGIES.includes(row.strategyId);
      if (strategy === "other" ? known : strategy !== "all" && row.strategyId !== strategy) return false;
      if (assets === "stable" && !row.stablecoinOnly) return false;
      if (assets === "volatile" && row.stablecoinOnly) return false;
      return !needle || [row.name, row.address, row.creator].some(value => value.toLowerCase().includes(needle));
    });
    const key = (row: AgentRow) => sort === "return" ? row.returnBps ?? -Infinity : sort === "tvl" ? Number(tvl(row)) : -(row.since ?? Infinity);
    return filtered.sort((a, b) => key(b) - key(a));
  }, [data, strategy, assets, query, sort]);
  const hidden = (data?.rows.length ?? 0) - rows.length;
  const featured = rows.filter(row => row.featured);
  const community = rows.filter(row => !row.featured);
  const published = data?.rows.filter(row => !row.featured).length ?? 0;
  const paused = data?.rows.filter(row => row.paused).length ?? 0;
  const totalRules = data?.rows.reduce((sum, row) => sum + (row.rules?.total ?? 0), 0) ?? 0;
  const oldest = data?.rows.reduce<number | null>((min, row) => row.since !== null && (min === null || row.since < min) ? row.since : min, null) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description="Every number here comes from on-chain events."
        aside={
          <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-full border border-input bg-card px-4 py-2 text-caption shadow-card">
            <span className="text-muted-foreground">Total in vaults</span>
            <span className="font-medium tabular-nums" data-testid="total-in-vaults">{data ? `${formatUsdc(data.totalNav)} USDC` : "Reading vaults…"}</span>
          </div>
        }
      />
      {account && <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Compare the assets and limits, then open a vault to deposit.</p>
        {holdingsQuery.data && BigInt(holdingsQuery.data.usdcBalance ?? "0") === 0n ? (
          <Button asChild data-primary><Link href="/onboarding">Get test USDC <ArrowRight aria-hidden="true" /></Link></Button>
        ) : rows[0] ? (
          <Button asChild data-primary><Link href={`/agents/${rows[0].id}#deposit`}>Open {rows[0].name} <ArrowRight aria-hidden="true" /></Link></Button>
        ) : data && data.rows.length === 0 ? (
          <Button asChild data-primary><Link href="/create">Publish an agent</Link></Button>
        ) : data ? (
          <Button data-primary onClick={() => { setStrategy("all"); setAssets("all"); setQuery(""); }}>Clear filters</Button>
        ) : (
          <Button data-primary pending={isFetching} onClick={() => void refetch()}>Read agents again</Button>
        )}
      </div>}
      <dl className="grid grid-cols-2 gap-4 text-caption sm:flex sm:gap-8">
        <div className="space-y-1">
          <dt className="text-muted-foreground">Agents</dt>
          <dd className="text-subheading font-medium tabular-nums" data-testid="agents-count">{data ? data.rows.length : "—"}</dd>
          <dd className="text-muted-foreground">
            {data ? `${data.rows.length - published} demo, ${published} published with Create${paused > 0 ? ` · ${paused} paused` : ""}` : "Reading the vault factory…"}
          </dd>
        </div>
        <div className="space-y-1 border-l pl-4 sm:pl-8">
          <dt className="text-muted-foreground">Rules enforced on-chain</dt>
          <dd className="text-subheading font-medium tabular-nums">{data ? totalRules : "—"}</dd>
          <dd className="text-muted-foreground">{oldest ? `History since inception (${formatAge(oldest)})` : "Allowlisted calls and limits"}</dd>
        </div>
      </dl>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b px-4 py-4 sm:px-6 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2">
            <FilterPills label="Strategy" options={STRATEGIES} value={strategy} onChange={setStrategy} />
            <FilterPills label="Assets" options={ASSETS} value={assets} onChange={setAssets} />
          </div>
          <label className="relative lg:ml-auto">
            <span className="sr-only">Filter agents</span>
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter agents" className="h-9 w-full rounded-full bg-secondary pr-4 pl-9 text-sm placeholder:text-muted-foreground focus-visible:outline-ring lg:w-56" />
          </label>
        </div>

        {isPending && <SkeletonRows />}
        {error && !data && (
          <div role="alert" className="flex flex-col items-start gap-3 px-6 py-10">
            <p className="flex items-center gap-2 font-medium"><CircleAlert aria-hidden="true" className="size-4 text-muted-foreground" />Stellar did not answer</p>
            <p className="text-sm text-muted-foreground">{error.message}</p>
            <Button variant="outline" onClick={() => void refetch()} pending={isFetching}>Try again</Button>
          </div>
        )}
        {data && data.rows.length === 0 && (
          <div className="flex flex-col items-start gap-3 px-6 py-10">
            <p className="font-medium">No agents yet — create the first one</p>
            <p className="text-sm text-muted-foreground">Neither the demo vaults nor any agent published with Create is on the factory.</p>
            <Button asChild variant="outline"><Link href="/create"><Plus aria-hidden="true" />Publish an agent</Link></Button>
          </div>
        )}
        {data && data.rows.length > 0 && rows.length === 0 && (
          <div className="px-6 py-10 text-sm text-muted-foreground">No agent matches these filters.</div>
        )}
        {data && rows.length > 0 && (
          <div className="pb-2">
            <AgentTable title="Featured agents" rows={featured} holdings={holdings} signedIn={account !== null} sort={sort} onSort={setSort} />
            <AgentTable
              title="Community agents"
              rows={community}
              holdings={holdings}
              signedIn={account !== null}
              sort={sort}
              onSort={setSort}
              empty={published === 0 ? (
                <p className="px-6 pt-1 pb-6 text-sm text-muted-foreground" data-testid="community-empty">
                  No community agents yet. Agents published with Create appear here, with the rules they can never break.
                </p>
              ) : undefined}
            />
          </div>
        )}
        {data && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-6 py-3 text-caption text-muted-foreground">
            <span>Return and drawdown: share price between the first and last NavSnapshot events the RPC retains (about 7 days).</span>
            {hidden > 0 && <span>{hidden} hidden by filters.</span>}
            <Link href="/create" className="inline-flex items-center gap-1 text-primary hover:underline lg:ml-auto">Publish an agent <ArrowRight aria-hidden="true" className="size-3" /></Link>
          </p>
        )}
      </Card>
    </div>
  );
}
