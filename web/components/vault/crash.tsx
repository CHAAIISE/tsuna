"use client";

import { CircleAlert, FlaskConical, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { CRASH_STEP_IDS, type CrashRunView, type CrashStepId } from "@/lib/crash/types";
import type { VaultDetail } from "@/lib/stellar/types";
import { CrashLive } from "./crash/live";
import { StepItem, type StepState } from "./crash/step-item";
import { STEP_COPY } from "./crash/steps";
import { useCrash, useCrashStep } from "./crash/use-crash";
import { Timeline } from "./timeline";

/** Step whose button is offered: the one running, the next one, the restore, or a new run. */
function currentStep(run: CrashRunView | null): CrashStepId {
  if (!run) return "prepare";
  if (run.busy) return run.busy;
  if (run.next) return run.next;
  return run.needsRestore ? "restore" : "prepare";
}

function stepState(id: CrashStepId, run: CrashRunView | null, current: CrashStepId, finished: boolean): StepState {
  const view = run?.steps.find(step => step.id === id);
  if (run?.busy === id) return "running";
  if (view?.status === "done") return "done";
  if (!finished && id === current) return view?.status === "failed" ? "failed" : "current";
  if (view?.status === "failed") return "failed";
  // A restore ends the run: steps it never reached stay unrun.
  return run && run.next === null && run.steps.some(step => step.id === "restore") ? "skipped" : "pending";
}

/**
 * Guided market crash on the demo oracle: each step sends real testnet transactions and shows
 * what the chain answered, with the vault's health factor, NAV and pause read live.
 */
export function CrashPanel({ vault }: { vault: VaultDetail }) {
  const crash = useCrash(vault.id);
  const start = useCrashStep(vault.id);
  const data = crash.data;
  if (!data?.vault) return null;

  const run = data.run;
  const finished = Boolean(run && !run.busy && run.next === null && !run.needsRestore);
  const current = currentStep(run);
  const busy = Boolean(run?.busy) || start.isPending;
  const disabled = data.unavailable !== null;

  return (
    <Card data-testid="crash-panel" aria-labelledby="crash-title">
      <CardHeader className="space-y-4 px-4 sm:px-6">
        <div className="space-y-2">
          <p className="font-overline text-caption tracking-overline text-muted-foreground">Stress test</p>
          <CardTitle id="crash-title">Market crash (demo oracle)</CardTitle>
          <CardDescription>Walk the vault through a 30 % XLM crash. Every step is a real Stellar transaction; the chain decides what passes.</CardDescription>
        </div>
        <div data-testid="demo-oracle-banner" className="flex gap-3 rounded-lg border border-dashed border-input bg-muted px-4 py-3">
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-foreground" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Demo oracle</p>
            <p className="text-muted-foreground">
              The demo fleet&apos;s oracle router is a testnet build with a demo switch: its admin can force a price. A mainnet build has no such function.
              {data.live ? (data.live.demo ? " Demo mode is on." : " Demo mode is off: the first step switches it on.") : ""}
            </p>
          </div>
        </div>
        {data.live ? <CrashLive live={data.live} /> : (
          <p role="status" className="text-sm text-muted-foreground">{data.liveError ?? "Reading the vault from Stellar…"}</p>
        )}
      </CardHeader>

      <CardContent className="px-4 sm:px-6">
        <ol aria-label="Crash steps">
          {CRASH_STEP_IDS.map((id, index) => {
            const state = stepState(id, run, current, finished);
            const offered = !finished && id === current;
            return (
              <StepItem key={id} id={id} index={index} state={state} view={run?.steps.find(step => step.id === id)} paused={data.live?.paused ?? false}>
                {id === "riskoff-repay" && run && run.journal.length > 0 && (
                  <details open={state === "running"} className="rounded-lg border px-4 py-3" data-testid="crash-agent-journal">
                    <summary className="text-sm text-muted-foreground">Risk-off agent journal ({run.journal.length} entries)</summary>
                    <div className="mt-3"><Timeline items={run.journal} empty="The agent has not acted yet." /></div>
                  </details>
                )}
                {offered && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="outline"
                      onClick={() => start.mutate(id)}
                      pending={state === "running" || (start.isPending && start.variables === id)}
                      disabled={disabled || busy}
                      data-testid={`crash-run-${id}`}
                    >
                      {state === "running" ? "Waiting for Stellar…" : state === "failed" ? `Retry: ${STEP_COPY[id].action}` : STEP_COPY[id].action}
                    </Button>
                    {id === "riskoff-repay" && state === "running" && <span className="text-caption text-muted-foreground">The model reads the vault, then proposes; this takes up to a minute.</span>}
                  </div>
                )}
              </StepItem>
            );
          })}
        </ol>
        {start.error && <p role="alert" className="mt-4 flex gap-2 text-sm text-muted-foreground"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{start.error.message}</p>}
        {disabled && <p className="mt-4 text-sm text-muted-foreground">{data.unavailable}</p>}
        {run?.autoRestored && <p className="mt-4 text-sm text-muted-foreground">This run sat idle, so the server restored the price and the pause on its own.</p>}
      </CardContent>

      {(finished || (run?.needsRestore && current !== "restore")) && (
        <CardFooter className="px-4 sm:px-6">
          {finished ? (
            <Button variant="outline" onClick={() => start.mutate("prepare")} pending={start.isPending} disabled={disabled} data-testid="crash-again">
              <RotateCcw aria-hidden="true" />Run the crash again
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => start.mutate("restore")} disabled={disabled || busy} data-testid="crash-stop">
              Stop and restore the price
            </Button>
          )}
          <span className="text-caption text-muted-foreground">
            {finished ? "Price restored and vault unpaused, both read back from the chain." : "Ends the demo now: clears the demo price and lifts the pause."}
          </span>
        </CardFooter>
      )}
    </Card>
  );
}
