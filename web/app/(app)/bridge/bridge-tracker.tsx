"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, LoaderCircle } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { StepId, StepStatus, StepTx } from "@/lib/cctp/bridge";
import { sepolia, stellar } from "@/lib/cctp/config";
import { formatUsdc } from "@/lib/cctp/format";
import type { BridgeJob } from "@/lib/cctp/jobs";

interface BridgeState {
  job: BridgeJob | null;
  bridge: { ready: boolean; amount: string; recipient?: string; vault?: string; sepoliaWallet?: string };
}

const stepLabels: Record<StepId, string> = {
  burn: "Burn on Ethereum",
  attestation: "Circle attestation",
  mint: "Mint on Stellar",
  swap: "Swap",
  deposit: "Deposit",
};

const statusLabels: Record<StepStatus, string> = {
  pending: "Not started",
  running: "In progress",
  done: "Done",
  failed: "Failed",
};

const explorerUrl = (tx: StepTx) => tx.network === "sepolia" ? `${sepolia.explorer}/tx/${tx.hash}` : `${stellar.explorer}/tx/${tx.hash}`;

async function fetchStatus(id?: string): Promise<BridgeState> {
  const response = await fetch(`/api/bridge${id ? `?id=${encodeURIComponent(id)}` : ""}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Bridge status unavailable (${response.status})`);
  return await response.json() as BridgeState;
}

function BridgeTracker() {
  const [state, setState] = useState<BridgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let active = true;
    fetchStatus()
      .then(next => { if (active) setState(next); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Bridge status unavailable"); });
    return () => { active = false; };
  }, []);

  const job = state?.job ?? null;
  const runningId = job?.status === "running" ? job.id : null;
  useEffect(() => {
    if (!runningId) return;
    const timer = setInterval(() => {
      fetchStatus(runningId).then(setState).catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [runningId]);
  const running = runningId !== null;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/bridge", { method: "POST" });
      const body = await response.json() as { job?: BridgeJob; error?: string };
      if (!response.ok && !body.job) throw new Error(body.error ?? `Could not start the bridge (${response.status})`);
      if (!response.ok) setError(body.error ?? null);
      setState(current => current && body.job ? { ...current, job: body.job } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the bridge");
    } finally {
      setStarting(false);
    }
  }

  const amount = state ? formatUsdc(BigInt(state.bridge.amount), 6) : null;
  const txs = job?.steps.flatMap(step => step.txs) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{amount ? `Bridge ${amount} USDC into the vault` : "Bridge USDC into the vault"}</CardTitle>
        <CardDescription>
          USDC is burned on Ethereum Sepolia, minted natively on Stellar by Circle&apos;s CCTP, swapped for the vault&apos;s USDC and deposited.
          This demo burns from a server-side test wallet, not from your own wallet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol data-testid="bridge-tracker" data-job-status={job?.status ?? "none"} className="grid gap-3 lg:grid-cols-5">
          {(job?.steps ?? (Object.keys(stepLabels) as StepId[]).map(id => ({ id, status: "pending" as const, txs: [] }))).map((step, index) => (
            <li key={step.id} data-testid={`bridge-step-${step.id}`} data-status={step.status} aria-current={step.status === "running" ? "step" : undefined} className="space-y-2 rounded-lg border bg-background p-4 text-caption">
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border font-medium",
                  step.status === "done" && "border-primary/20 bg-primary/10 text-primary",
                  step.status === "running" && "border-primary bg-primary text-primary-foreground",
                  (step.status === "pending" || step.status === "failed") && "border-border text-muted-foreground")}>
                  {step.status === "done" ? <Check className="size-3" /> : step.status === "running" ? <LoaderCircle className="size-3 animate-spin" /> : index + 1}
                </span>
                <span className="text-sm font-medium">{stepLabels[step.id]}</span>
              </div>
              <p className={step.status === "failed" ? "text-foreground" : "text-muted-foreground"}>
                <span data-testid={`bridge-step-${step.id}-status`}>{statusLabels[step.status]}</span>
                {"detail" in step && step.detail ? <span className="block break-words">{step.detail}</span> : null}
              </p>
            </li>
          ))}
        </ol>

        {!state && !error && <p id="bridge-availability" role="status" className="text-sm text-muted-foreground">Loading bridge status before deposits can start…</p>}
        {state && !job && <p className="text-sm text-muted-foreground">No bridge has run on this server yet.</p>}
        {job?.status === "done" && job.result && (
          <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
            <Badge variant="success">Deposited</Badge>
            <span>{formatUsdc(BigInt(job.result.deposited), 7)} USDC is now in the vault; the recipient received vault shares.</span>
          </div>
        )}
        {job?.status === "failed" && (
          <p role="alert" className="text-sm">The bridge stopped: {job.error}. Any funds already minted remain with the Stellar recipient. Check the transaction details before starting another bridge.</p>
        )}
        {error && <p id={!state ? "bridge-availability" : undefined} role="alert" className="text-sm">{error}{!state && " Reload this page to check availability again."}</p>}
        {state && !state.bridge.ready && <p id="bridge-availability" className="text-sm text-muted-foreground">New bridges are unavailable because the server&apos;s demo bridge wallet is not configured. You can still inspect the last run and explore agents.</p>}
        {running && <p role="status" className="text-sm text-muted-foreground">The bridge is running. This page updates automatically as each step completes; no further action is needed.</p>}

        <details className="text-caption">
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <dl className="mt-3 grid gap-2 sm:grid-cols-[16rem_1fr] [&_dd]:font-mono [&_dd]:break-all">
            {state?.bridge.sepoliaWallet && <><dt className="text-muted-foreground">Sepolia test wallet</dt><dd><a className="text-primary hover:underline" href={`${sepolia.explorer}/address/${state.bridge.sepoliaWallet}`} target="_blank" rel="noreferrer">{state.bridge.sepoliaWallet}</a></dd></>}
            {state?.bridge.recipient && <><dt className="text-muted-foreground">Stellar recipient</dt><dd><a className="text-primary hover:underline" href={`${stellar.explorer}/account/${state.bridge.recipient}`} target="_blank" rel="noreferrer">{state.bridge.recipient}</a></dd></>}
            {state?.bridge.vault && <><dt className="text-muted-foreground">Vault</dt><dd><a className="text-primary hover:underline" href={`${stellar.explorer}/contract/${state.bridge.vault}`} target="_blank" rel="noreferrer">{state.bridge.vault}</a></dd></>}
            <dt className="text-muted-foreground">CCTP forwarder</dt><dd>{stellar.cctpForwarder}</dd>
            {job?.result && <><dt className="text-muted-foreground">Shares received</dt><dd>{job.result.shares}</dd></>}
            {txs.map(tx => (
              <div key={`${tx.network}-${tx.hash}`} className="contents">
                <dt className="text-muted-foreground">{tx.label} ({tx.network === "sepolia" ? "Sepolia" : "Stellar"})</dt>
                <dd><a className="text-primary hover:underline" href={explorerUrl(tx)} target="_blank" rel="noreferrer">{tx.hash}</a></dd>
              </div>
            ))}
          </dl>
        </details>
      </CardContent>
      <CardFooter>
        {job?.status === "done" && <Button data-primary asChild><Link href="/agents">Explore agents</Link></Button>}
        <Button data-primary={job?.status === "done" ? undefined : true} variant={job?.status === "done" ? "outline" : "default"} onClick={start} pending={starting || running} disabled={!state?.bridge.ready} aria-describedby={!state?.bridge.ready ? "bridge-availability" : undefined}>
          {running ? "Waiting for the bridge…" : job?.status === "done" ? "Bridge again" : "Bridge and deposit"}
        </Button>
        {job && <span className="text-caption text-muted-foreground">Last run started {new Date(job.createdAt).toLocaleString("en-US")}</span>}
      </CardFooter>
    </Card>
  );
}

export { BridgeTracker };
