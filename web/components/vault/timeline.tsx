"use client";

import { ArrowRight, Check, CircleAlert, ExternalLink, LockKeyhole, MessageSquareText, Minus, Play, Wallet } from "lucide-react";
import { cn } from "cn";
import { explorerTx, formatUsdc, formatWhen, shortAddress } from "@/lib/stellar/format";
import type { TimelineAction, TimelineFlow, TimelineItem, TimelineNote, TimelineRun } from "@/lib/stellar/types";
import styles from "./wall.module.css";

function TxLink({ hash, label = "View on Stellar Expert" }: { hash: string; label?: string }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" data-testid="tx-link" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
      {label} <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  );
}

function Stage({ label, state }: { label: string; state: "done" | "failed" | "skipped" | "blocked" | "authorized" }) {
  const tone = {
    done: "border-border bg-card text-foreground",
    authorized: "border-success/30 bg-success/10 text-foreground",
    failed: "border-destructive/30 bg-destructive-soft text-destructive",
    blocked: "border-destructive/30 bg-destructive-soft text-destructive",
    skipped: "border-dashed border-border text-muted-foreground",
  }[state];
  const Icon = state === "skipped" ? Minus : state === "failed" || state === "blocked" ? LockKeyhole : Check;
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption ${tone}`}><Icon aria-hidden="true" className="size-3" />{label}</span>;
}

const ROLE_LABEL: Record<string, string> = { default: "Yield agent", riskoff: "Risk-off agent" };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? `Role ${role}`;

function ActionItem({ item }: { item: TimelineAction }) {
  const blocked = item.outcome === "blocked" || item.simulation?.ok === false;
  const error = item.error ?? item.simulation?.error ?? null;
  const simulated = item.simulation ? (item.simulation.ok ? "done" : "failed") : "skipped";
  const outcomeLabel = { authorized: "Authorized", blocked: "Blocked on-chain", "simulated-only": "Not submitted", rejected: "Rejected by the runtime" }[item.outcome];
  return (
    <li
      data-testid="timeline-action"
      data-outcome={item.outcome}
      data-source={item.source}
      data-hash={item.hash ?? undefined}
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 space-y-3 rounded-lg px-4 py-3 duration-200",
        blocked ? cn("border-l-[3px] border-destructive bg-destructive-soft", item.outcome === "blocked" && styles.wall) : "border bg-card",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-caption text-muted-foreground">{roleLabel(item.role)} · {item.source === "run" ? "run from this app" : "seen on-chain"} · {formatWhen(item.at)}</p>
          <p className="font-medium break-words">{item.label}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1" aria-label="Stages">
          <Stage label="Proposed" state={item.proposed ? "done" : "skipped"} />
          <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
          <Stage label="Simulated" state={simulated} />
          <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
          <Stage
            label={outcomeLabel}
            state={item.outcome === "authorized" ? "authorized" : item.outcome === "blocked" ? "blocked" : "skipped"}
          />
        </div>
      </div>
      {blocked && (
        <div className="space-y-1">
          <p className="flex items-center gap-2 font-medium text-destructive" data-testid="refusal-name"><LockKeyhole aria-hidden="true" className="size-4" />{error ? error.name : "Refused on-chain"}</p>
          <p className="text-sm">{error ? `The chain refused: ${error.message}` : "The vault refused this call. Its error detail is no longer retained by the RPC."}</p>
        </div>
      )}
      {item.outcome === "rejected" && item.reason && <p className="text-sm text-muted-foreground">The runtime did not build this call: {item.reason}</p>}
      {item.outcome === "authorized" && item.navBefore && item.navAfter && (
        <p className="text-sm text-muted-foreground">NAV {formatUsdc(item.navBefore)} → <span className="text-foreground">{formatUsdc(item.navAfter)} USDC</span></p>
      )}
      {(item.hash || error) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
          {item.hash && <TxLink hash={item.hash} label={item.outcome === "authorized" ? "Authorized transaction" : "Failed transaction"} />}
          <details className="w-full">
            <summary className={cn("w-fit", blocked ? "text-destructive" : "text-muted-foreground")}>Details</summary>
            <dl className="mt-2 grid gap-1 sm:grid-cols-[8rem_1fr]">
              {item.hash && <><dt className="text-muted-foreground">Transaction</dt><dd className="font-mono break-all">{item.hash}</dd></>}
              {error && <><dt className="text-muted-foreground">Error</dt><dd className="font-mono">{error.name} ({error.contract} #{error.code})</dd></>}
              <dt className="text-muted-foreground">Role</dt><dd className="font-mono">{item.role}</dd>
              {item.navBefore && <><dt className="text-muted-foreground">NAV before</dt><dd className="font-mono">{item.navBefore}</dd></>}
            </dl>
          </details>
        </div>
      )}
    </li>
  );
}

function NoteItem({ item }: { item: TimelineNote }) {
  const model = item.tool === null;
  return (
    <li className={cn("animate-in fade-in slide-in-from-bottom-1 flex gap-3 px-1 py-1 text-sm duration-200", item.failed && "rounded-lg border-l-[3px] border-destructive bg-destructive-soft px-3 py-2")}>
      {model ? <MessageSquareText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" /> : <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
      <div className="min-w-0 space-y-1">
        <p className={cn(model ? "text-foreground" : "text-muted-foreground", item.failed && "text-destructive")}>{item.text}</p>
        {(item.detail || item.hash) && (
          <details className="text-caption">
            <summary className="w-fit text-muted-foreground">Details</summary>
            {item.hash && <p className="mt-1"><TxLink hash={item.hash} label="Payment transaction" /></p>}
            {item.detail && <p className="mt-1 font-mono break-all text-muted-foreground">{item.detail.slice(0, 600)}</p>}
          </details>
        )}
      </div>
    </li>
  );
}

function FlowItem({ item }: { item: TimelineFlow }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
      <Wallet aria-hidden="true" className="size-4 text-muted-foreground" />
      <span><span className="font-medium">{item.type === "deposit" ? "Deposit" : "Withdrawal"}</span> of {formatUsdc(item.amount)} USDC by {shortAddress(item.user)}</span>
      <span className="text-caption text-muted-foreground">{formatWhen(item.at)}</span>
      <span className="ml-auto text-caption"><TxLink hash={item.hash} label="Transaction" /></span>
    </li>
  );
}

function RunItem({ item }: { item: TimelineRun }) {
  return (
    <li className="flex flex-wrap items-center gap-2 pt-2 text-caption text-muted-foreground">
      <Play aria-hidden="true" className="size-3" />
      <span>Agent run {item.status === "running" ? "in progress" : item.status === "failed" ? "stopped" : "finished"} · {roleLabel(item.role)}{item.model ? ` · ${item.model}` : ""} · {formatWhen(item.at)}</span>
      {item.error && <span className="flex items-center gap-1"><CircleAlert aria-hidden="true" className="size-3" />{item.error}</span>}
    </li>
  );
}

/** Agent journal: proposed → simulated → authorized/blocked, with a crimson wall on each refusal. */
export function Timeline({ items, empty }: { items: TimelineItem[]; empty: React.ReactNode }) {
  if (items.length === 0) return <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{empty}</div>;
  return (
    <ol className="space-y-3" data-testid="agent-journal">
      {items.map(item => {
        switch (item.type) {
          case "action": return <ActionItem key={item.id} item={item} />;
          case "note": return <NoteItem key={item.id} item={item} />;
          case "run": return <RunItem key={item.id} item={item} />;
          default: return <FlowItem key={item.id} item={item} />;
        }
      })}
    </ol>
  );
}
