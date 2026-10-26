"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, Play } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchJson } from "@/lib/hooks/fetch-json";
import { queryKeys } from "@/lib/hooks/keys";
import { useAgentRun, useStartRun } from "@/lib/hooks/use-agent-run";
import { usePasskeyAccount } from "@/lib/hooks/use-passkey-account";
import { useActivity, useHoldings, useVault } from "@/lib/hooks/use-vault";
import { explorerAccount, shortAddress } from "@/lib/stellar/format";
import type { ActivityResponse, TimelineItem, VaultDetail } from "@/lib/stellar/types";
import { CrashPanel } from "./crash";
import { DepositPanel } from "./deposit-panel";
import { VaultKpis } from "./kpis";
import { Positions } from "./positions";
import { TsunaRules } from "./rules";
import { Timeline } from "./timeline";

type Tab = "overview" | "activity" | "rules";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "activity", label: "Activity" }, { id: "rules", label: "Tsuna rules" },
];
/** Journal items shown on the overview; the Activity tab has them all. */
const OVERVIEW_ITEMS = 12;

function RunAgentButton({ vault }: { vault: VaultDetail }) {
  const run = useAgentRun(vault.id);
  const start = useStartRun(vault.id);
  const running = start.isPending || run.data?.status === "running";
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button variant="outline" onClick={() => start.mutate()} pending={running} disabled={!vault.runnable} data-testid="run-agent">
        {!running && <Play aria-hidden="true" />}
        {running ? "Agent is working…" : "Run agent"}
      </Button>
      {!vault.runnable && <p className="text-caption text-muted-foreground">This server does not hold this agent&apos;s session key.</p>}
      {start.error && <p role="alert" className="max-w-xs text-caption text-muted-foreground">{start.error.message}</p>}
      {run.data?.status === "failed" && run.data.error && <p role="alert" className="flex max-w-xs gap-1 text-caption text-muted-foreground"><CircleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0" />{run.data.error}</p>}
    </div>
  );
}

function SkeletonPage() {
  return (
    <div role="status" aria-label="Loading vault" className="space-y-6">
      <div className="h-11 w-64 skeleton rounded" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map(i => <div key={i} className="h-28 skeleton rounded-xl" />)}</div>
      <div className="h-64 skeleton rounded-xl" />
      <p className="text-caption text-muted-foreground">Reading the vault from Stellar…</p>
      <Button data-primary pending>Reading vault…</Button>
    </div>
  );
}

/** Vault page: KPIs, positions, the agent's journal, its rules, and the deposit panel. */
export function VaultView({ id }: { id: string }) {
  const vault = useVault(id);
  const run = useAgentRun(id);
  const running = run.data?.status === "running";
  const activity = useActivity(id, { live: running });
  const { account } = usePasskeyAccount();
  const holdings = useHoldings(account?.account ?? null);
  const client = useQueryClient();
  const [tab, setTab] = useState<Tab>("overview");

  // When a run ends, read the vault and its activity again past the server caches.
  const lastFinishedRun = useRef<string | null>(null);
  useEffect(() => {
    if (run.data && run.data.status !== "running" && lastFinishedRun.current !== run.data.id) {
      lastFinishedRun.current = run.data.id;
      void Promise.all([
        fetchJson<ActivityResponse>(`/api/vaults/${encodeURIComponent(id)}/activity?fresh=1`).then(data => client.setQueryData(queryKeys.activity(id), data)),
        fetchJson<VaultDetail>(`/api/vaults/${encodeURIComponent(id)}?fresh=1`).then(data => client.setQueryData(queryKeys.vault(id), data)),
      ]).catch(() => undefined);
    }
  }, [run.data, id, client]);

  const journal = useMemo(() => {
    const live = run.data?.items ?? [];
    const seen = new Set(live.map(item => item.id));
    const hashes = new Set(live.flatMap(item => "hash" in item && item.hash ? [item.hash] : []));
    const stored = (activity.data?.items ?? []).filter(item =>
      !seen.has(item.id)
      && !("runId" in item && item.runId === run.data?.id)
      && !(item.type === "action" && item.hash && hashes.has(item.hash)));
    return [...live, ...stored];
  }, [run.data, activity.data]);
  const agentItems = journal.filter((item): item is Exclude<TimelineItem, { type: "deposit" | "withdraw" }> => item.type !== "deposit" && item.type !== "withdraw");

  if (vault.isPending) return <SkeletonPage />;
  if (vault.error || !vault.data) {
    return (
      <div role="alert" className="space-y-3 py-10">
        <p className="font-medium">This vault could not be read</p>
        <p className="text-sm text-muted-foreground">{vault.error?.message ?? "Unknown vault."}</p>
        <div className="flex gap-3"><Button data-primary onClick={() => void vault.refetch()}>Try again</Button><Button asChild variant="ghost"><Link href="/agents">Back to agents</Link></Button></div>
      </div>
    );
  }
  const data = vault.data;
  const holding = holdings.data?.holdings.find(entry => entry.vault === data.address);
  const balance = account ? holdings.data ? holdings.data.usdcBalance : undefined : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          <Link href="/agents" className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"><ArrowLeft aria-hidden="true" className="size-3" />Agents</Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-page font-normal tracking-tight">{data.name.startsWith("Agent") ? data.name : `Agent ${data.name}`}</h1>
            {data.paused && <span className="rounded-full bg-destructive-soft px-3 py-1 text-caption text-destructive" data-testid="paused">Paused — withdrawals stay open</span>}
          </div>
          <p className="max-w-2xl text-base text-muted-foreground">{data.strategy ?? "A vault with a custom policy."}</p>
          <p className="text-caption text-muted-foreground">
            Created by <a href={explorerAccount(data.creator)} target="_blank" rel="noreferrer" className="hover:text-primary" title={data.creator}>{shortAddress(data.creator)}</a>
            {" · "}<a href={explorerAccount(data.address)} target="_blank" rel="noreferrer" className="hover:text-primary" title={data.address}>Vault contract</a>
          </p>
        </div>
        <RunAgentButton vault={data} />
      </div>

      <VaultKpis vault={data} />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          <div role="tablist" aria-label="Vault sections" className="grid w-full grid-cols-4 gap-1 rounded-full bg-secondary p-1 text-caption sm:flex sm:w-fit sm:text-sm">
            {TABS.map(entry => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`panel-${entry.id}`}
                onClick={() => setTab(entry.id)}
                className={cn("rounded-full border border-transparent px-2 py-2 whitespace-nowrap transition-colors sm:px-4 sm:py-1.5", tab === entry.id ? "border-input bg-card shadow-card" : "text-muted-foreground hover:text-foreground")}
              >
                {entry.label}
              </button>
            ))}
            <Link href={`/agents/${encodeURIComponent(id)}/attack`} className="rounded-full border border-transparent px-2 py-2 text-center whitespace-nowrap text-muted-foreground hover:text-foreground sm:px-4 sm:py-1.5">Attack lab</Link>
          </div>

          {tab === "overview" && (
            <div id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" className="space-y-6">
              <CrashPanel vault={data} />
              <Card className="overflow-hidden">
                <CardHeader><CardTitle>Positions by protocol</CardTitle><CardDescription>Read from each protocol and valued at the oracle prices the vault itself uses.</CardDescription></CardHeader>
                <Positions positions={data.positions} exposure={data.exposure} />
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Agent journal</CardTitle>
                  <CardDescription>The agent proposes, the vault simulates and decides. Refusals are real failed transactions. {agentItems.length > 0 && `Showing ${Math.min(agentItems.length, OVERVIEW_ITEMS)} recent entries; scroll the journal to read each one.`}</CardDescription>
                </CardHeader>
                <div className="px-6 pb-6">
                  {activity.error && !activity.data && !running ? <p role="alert" className="rounded-lg border bg-muted px-4 py-3 text-sm text-muted-foreground">{activity.error.message}</p> : activity.isPending && !running ? <p role="status" className="rounded-lg border bg-muted px-4 py-3 text-sm text-muted-foreground">Reading the journal…</p> : (
                    <div role="region" aria-label="Recent agent journal" tabIndex={agentItems.length ? 0 : undefined} className="max-h-screen overflow-y-auto rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                      <Timeline items={agentItems.slice(0, OVERVIEW_ITEMS)} empty="The agent hasn't acted yet — run it." />
                    </div>
                  )}
                  {agentItems.length > OVERVIEW_ITEMS && <Button variant="link" className="mt-3 px-0" onClick={() => setTab("activity")}>See all activity</Button>}
                </div>
              </Card>
            </div>
          )}

          {tab === "activity" && (
            <div id="panel-activity" role="tabpanel" aria-labelledby="tab-activity">
              <Card>
                <CardHeader>
                  <CardTitle>Activity</CardTitle>
                  <CardDescription>Vault events, failed vault calls found on Stellar, and the journal of runs started here. History follows the RPC&apos;s retention (about 7 days).</CardDescription>
                </CardHeader>
                <div className="px-6 pb-6">
                  {activity.error && !activity.data ? <p role="alert" className="text-sm text-muted-foreground">{activity.error.message}</p> : (
                    <Timeline items={journal} empty={activity.isPending ? "Reading activity…" : "No activity in the retained history."} />
                  )}
                </div>
              </Card>
            </div>
          )}

          {tab === "rules" && (
            <div id="panel-rules" role="tabpanel" aria-labelledby="tab-rules"><TsunaRules vault={data} /></div>
          )}
        </div>

        <aside className="order-first space-y-4 lg:sticky lg:top-6 lg:order-none">
          <DepositPanel vault={data} owner={account} holding={holding} balance={balance} />
          <p className="px-1 text-caption text-muted-foreground">Performance fee: 10% of gains above the high-water mark, crystallized on deposits, withdrawals and agent calls.</p>
        </aside>
      </div>
    </div>
  );
}
