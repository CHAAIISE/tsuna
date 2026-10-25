import { Check, CircleAlert, ExternalLink, LoaderCircle, LockKeyhole, Minus } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { CrashStepId, CrashStepView, CrashTxView } from "@/lib/crash/types";
import { explorerTx } from "@/lib/stellar/format";
import styles from "../wall.module.css";
import { STEP_COPY } from "./steps";

export type StepState = "pending" | "current" | "running" | "done" | "failed" | "skipped";

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" data-testid="crash-tx-link" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
      {label} <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  );
}

/** One transaction of a step: a crimson wall when the chain refused it, a plain line otherwise. */
function Transaction({ tx }: { tx: CrashTxView }) {
  if (tx.status === "FAILED") {
    return (
      <div data-testid="crash-wall" data-error={tx.error?.name} data-hash={tx.hash} className={cn("space-y-2 rounded-lg border-l-[3px] border-destructive bg-destructive-soft px-4 py-3", styles.wall)}>
        <p className="text-caption text-muted-foreground">{tx.label}</p>
        <p className="flex items-center gap-2 font-medium text-destructive"><LockKeyhole aria-hidden="true" className="size-4" />{tx.error?.name ?? "Refused on-chain"}</p>
        {tx.error && <p className="text-sm">The chain refused: {tx.error.message}</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
          <TxLink hash={tx.hash} label="Failed transaction" />
          <details className="w-full">
            <summary className="w-fit text-destructive">Details</summary>
            <dl className="mt-2 grid gap-1 sm:grid-cols-[8rem_1fr]">
              <dt className="text-muted-foreground">Transaction</dt><dd className="font-mono break-all">{tx.hash}</dd>
              <dt className="text-muted-foreground">Status</dt><dd className="font-mono">{tx.status}</dd>
              {tx.error && <><dt className="text-muted-foreground">Error</dt><dd className="font-mono">{tx.error.name} ({tx.error.contract} #{tx.error.code})</dd></>}
            </dl>
          </details>
        </div>
      </div>
    );
  }
  return (
    <div data-testid="crash-tx" data-hash={tx.hash} className="flex gap-3 rounded-lg border bg-card px-3 py-2 text-sm">
      <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <span className="break-words">{tx.label}</span>
        <span className="shrink-0 text-caption"><TxLink hash={tx.hash} label="Transaction" /></span>
      </div>
    </div>
  );
}

function Marker({ index, state }: { index: number; state: StepState }) {
  const base = "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-caption font-medium tabular-nums";
  if (state === "done") return <span className={cn(base, "border-success/30 bg-success/10 text-success")}><Check aria-hidden="true" className="size-3.5" /><span className="sr-only">Done</span></span>;
  if (state === "running") return <span className={cn(base, "border-primary/40 bg-card text-primary")}><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" /><span className="sr-only">Running</span></span>;
  if (state === "failed") return <span className={cn(base, "border-input bg-card text-muted-foreground")}><CircleAlert aria-hidden="true" className="size-3.5" /><span className="sr-only">Stopped</span></span>;
  if (state === "skipped") return <span className={cn(base, "border-dashed bg-card text-muted-foreground")}><Minus aria-hidden="true" className="size-3.5" /><span className="sr-only">Skipped</span></span>;
  return <span className={cn(base, state === "current" ? "border-primary bg-card text-primary" : "bg-card text-muted-foreground")}>{index + 1}</span>;
}

/** One step of the guided crash: what it does, then the transactions it sent and what the chain read back. */
export function StepItem({ id, index, state, view, paused, children }: {
  id: CrashStepId;
  index: number;
  state: StepState;
  view: CrashStepView | undefined;
  /** The vault reads as paused now. */
  paused: boolean;
  children?: React.ReactNode;
}) {
  const copy = STEP_COPY[id];
  const muted = state === "pending" || state === "skipped";
  return (
    <li data-testid={`crash-step-${id}`} data-state={state} aria-current={state === "current" || state === "running" ? "step" : undefined} className="group relative flex gap-3 pb-6 last:pb-0 sm:gap-4">
      <span aria-hidden="true" className="absolute top-7 bottom-0 left-3.5 w-px bg-border group-last:hidden" />
      <Marker index={index} state={state} />
      <div className="min-w-0 flex-1 space-y-3 pt-0.5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className={cn("font-medium", muted && "text-muted-foreground")}>{copy.title}</p>
            {id === "pause" && state === "done" && paused && <Badge variant="destructive" data-testid="crash-pause-badge">Vault paused</Badge>}
            {state === "skipped" && <span className="text-caption text-muted-foreground">Not run</span>}
          </div>
          <p className="text-sm text-muted-foreground">{copy.detail}</p>
        </div>
        {view && view.txs.length > 0 && <div className="space-y-2">{view.txs.map(tx => <Transaction key={tx.hash} tx={tx} />)}</div>}
        {view && view.notes.length > 0 && (
          <ul className="space-y-1 text-sm">{view.notes.map(note => <li key={note} className="flex gap-2"><span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />{note}</li>)}</ul>
        )}
        {view?.status === "failed" && view.error && (
          <p role="alert" className="flex gap-2 text-sm text-muted-foreground"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{view.error}</p>
        )}
        {children}
      </div>
    </li>
  );
}
