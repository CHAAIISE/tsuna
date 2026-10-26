"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import type { BuildInfo, FleetState, FleetVault } from "@/lib/fleet/read";
import { ensureSession } from "@/lib/passkey/session";

const EXPLORER = "https://stellar.expert/explorer/testnet";
/** Ledger timestamps trail the wall clock by a few seconds. */
const LEDGER_LAG_SECS = 6;


function duration(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  const minutes = Math.floor(s / 60);
  return `${String(minutes).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function buildName(build: BuildInfo): string {
  if (build.title) return build.title;
  return build.meta.leash_build ? `Build ${build.meta.leash_build}` : "Undescribed build";
}

function HashChip({ hash }: { hash: string }) {
  return (
    <details className="min-w-0 text-caption">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Code details</summary>
      <p className="mt-2 break-all font-mono text-muted-foreground">{hash}</p>
    </details>
  );
}

interface ActionResult {
  kind: "propose" | "apply";
  hash: string;
}

interface Refusal {
  message: string;
  code?: string;
}

export function FleetConsole({ initial }: { initial: FleetState }) {
  const [state, setState] = useState(initial);
  const [selected, setSelected] = useState(initial.candidates[0]?.hash ?? "");
  const [busy, setBusy] = useState<"propose" | "apply" | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  // Unknown until mounted: the server clock must not leak into the hydrated countdown.
  const [now, setNow] = useState<number | null>(null);

  const eta = state.pending?.eta ?? null;
  useEffect(() => {
    if (eta === null) return;
    const tick = () => setNow(Date.now() / 1000);
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [eta]);

  async function act(kind: "propose" | "apply") {
    setBusy(kind);
    setRefusal(null);
    try {
      await ensureSession("propose a patch");
      const response = await fetch("/api/fleet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kind === "propose" ? { fleet: state.id, action: kind, wasmHash: selected } : { fleet: state.id, action: kind }),
      });
      const body = await response.json() as { hash?: string; state?: FleetState | null; error?: string; code?: string };
      if (!response.ok || !body.hash) {
        setRefusal({ message: body.error ?? `The request failed (${response.status}).`, ...(body.code ? { code: body.code } : {}) });
        return;
      }
      setResult({ kind, hash: body.hash });
      setNow(Date.now() / 1000);
      if (body.state) {
        setState(body.state);
        setSelected(body.state.candidates[0]?.hash ?? "");
      }
    } catch (cause) {
      setRefusal({ message: cause instanceof Error ? cause.message : "Stellar did not respond. Try again in a moment." });
    } finally {
      setBusy(null);
    }
  }

  const { current, pending, vaults } = state;
  const onCurrent = vaults.filter(vault => current && vault.wasmHash === current.hash).length;
  const uniform = vaults.length > 0 && onCurrent === vaults.length;
  const remaining = eta === null || now === null ? null : eta + LEDGER_LAG_SECS - now;
  const ready = pending !== null && remaining !== null && remaining <= 0;

  return (
    <div className="space-y-6">
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-3">
          <div className="col-span-2 space-y-1 border-b p-4 sm:col-span-1 sm:border-b-0 sm:p-6">
            <p className="text-caption text-muted-foreground">Vault executable · {state.tag}</p>
            <p className="text-subheading font-medium" data-testid="current-build">{current ? buildName(current) : "Not published"}</p>
            {current?.description && <p className="text-caption text-muted-foreground">{current.description}</p>}
            {current && <HashChip hash={current.hash} />}
          </div>
          <div className="space-y-1 p-4 sm:border-l sm:p-6">
            <p className="text-caption text-muted-foreground">Vaults on this build</p>
            <p className="text-subheading font-medium tabular-nums" data-testid="fleet-uniform">{onCurrent} of {vaults.length}</p>
            <p className="text-caption text-muted-foreground">Each vault points at the factory&apos;s reference, not at its own copy.</p>
          </div>
          <div className="space-y-1 border-l p-4 sm:p-6">
            <p className="text-caption text-muted-foreground">Upgrade rule</p>
            <p className="text-subheading font-medium">2 of 2 admins · {Math.round(state.timelockSecs / 60)} min timelock</p>
            <p className="text-caption text-muted-foreground">Every patch is public before it can land.</p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{pending ? "Patch waiting for its timelock" : "Patch the fleet"}</CardTitle>
          <CardDescription>
            {pending
              ? "Anyone can inspect this build until the timelock ends. Then one transaction moves every vault."
              : "Pick an uploaded vault build. Proposing it starts the timelock; nothing changes until it is applied."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {pending ? (
            <PendingPatch build={pending.build} remaining={remaining} total={state.timelockSecs} />
          ) : state.candidates.length > 0 ? (
            <fieldset className="space-y-3">
              <legend className="sr-only">Vault build to propose</legend>
              {state.candidates.map(build => (
                <label key={build.hash} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-secondary", selected === build.hash && "border-primary bg-primary/5")}>
                  <input type="radio" name="build" value={build.hash} checked={selected === build.hash} onChange={() => setSelected(build.hash)} className="mt-1 accent-primary" />
                  <span className="min-w-0 space-y-1">
                    <span className="block font-medium">{buildName(build)}</span>
                    {build.description && <span className="block text-sm text-muted-foreground">{build.description}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="rounded-lg bg-secondary p-4 text-sm text-muted-foreground">No other vault build is uploaded yet. Every vault already runs the latest one.</p>
          )}
          {refusal && <RefusalWall refusal={refusal} />}
          <p id="fleet-next-action" className="text-sm text-muted-foreground">
            {pending
              ? ready ? "The timelock has ended. Apply this patch to update every vault." : "Apply becomes available when the timelock ends. No action is needed while you wait."
              : selected ? "This is a real upgrade proposal, signed by the demo admins. Review your selected build before proposing."
                : "Propose patch is unavailable until another vault build is uploaded."}
          </p>
          {result && !refusal && <ResultLine result={result} />}
        </CardContent>
        <CardFooter>
          {pending ? (
            <Button data-primary pending={busy === "apply"} disabled={!ready} aria-describedby="fleet-next-action" onClick={() => void act("apply")}>
              {busy === "apply" ? "Waiting for Stellar…" : "Apply to all vaults"}
            </Button>
          ) : (
            <Button data-primary pending={busy === "propose"} disabled={!selected} aria-describedby="fleet-next-action" onClick={() => void act("propose")}>
              {busy === "propose" ? "Waiting for Stellar…" : "Propose patch"}
            </Button>
          )}
          <span className="text-caption text-muted-foreground">Signed server-side by the factory&apos;s two admins.</span>
        </CardFooter>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Vaults</CardTitle>
            <CardDescription>Code read from each vault&apos;s instance entry and resolved through the factory.</CardDescription>
          </div>
          {vaults.length > 0 && (uniform
            ? <Badge variant="success" data-testid="fleet-proof">{vaults.length === 1 ? "On the current build" : vaults.length === 2 ? "Both vaults on the same build" : `All ${vaults.length} vaults on the same build`}</Badge>
            : <Badge variant="secondary">{onCurrent} of {vaults.length} on the current build</Badge>)}
        </CardHeader>
        {vaults.length === 0 ? (
          <CardContent><p className="text-sm text-muted-foreground">This factory has not deployed a vault yet.</p></CardContent>
        ) : (
          <div role="table" aria-label="Fleet vaults" className="text-table">
            <div role="row" className="hidden grid-cols-[1.4fr_1fr_1.3fr_1fr_1fr] gap-4 border-y bg-secondary/60 px-6 py-3 text-caption text-muted-foreground lg:grid">
              <span role="columnheader">Vault</span>
              <span role="columnheader">Executable</span>
              <span role="columnheader">Code (Wasm hash)</span>
              <span role="columnheader">Exposure caps</span>
              <span role="columnheader">Extra roles</span>
            </div>
            {vaults.map(vault => <VaultRow key={vault.address} vault={vault} factory={state.factory} current={current?.hash ?? null} />)}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Older policies, read without migration</CardTitle>
          <CardDescription>
            Exposure caps and extra roles arrived with the registry&apos;s PolicyV2. A policy written without them is still read by the new code:
            the missing fields come back empty and show as « not set ». The vault then applies its vault-wide exposure limit and only its default agent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <details className="text-caption">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
            <dl className="mt-3 space-y-3">
              <Detail label="Factory" value={state.factory} kind="contract" />
              <Detail label="Admin A" value={state.admins[0]} kind="account" />
              <Detail label="Admin B" value={state.admins[1]} kind="account" />
              {state.candidates.map(build => <div key={build.hash} className="space-y-1"><dt className="text-muted-foreground">{buildName(build)} · code hash</dt><dd className="break-all font-mono">{build.hash}</dd></div>)}
              {vaults.filter(vault => vault.registeredAsV1).map(vault => (
                <Detail key={vault.address} label={`${vault.name}: registered from a v1 policy (no exposure_caps, no roles keys)`} value={vault.registeredAsV1 ?? ""} kind="tx" />
              ))}
            </dl>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

function PendingPatch({ build, remaining, total }: { build: BuildInfo; remaining: number | null; total: number }) {
  const progress = remaining === null ? 0 : total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 1;
  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="pending-patch" data-hash={build.hash}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{buildName(build)}</p>
          {build.description && <p className="text-sm text-muted-foreground">{build.description}</p>}
          <HashChip hash={build.hash} />
        </div>
        <div className="text-right">
          <p className="text-caption text-muted-foreground">{remaining === null || remaining > 0 ? "Can be applied in" : "Timelock over"}</p>
          <p className="text-section font-medium tabular-nums" data-testid="timelock-countdown">{remaining === null ? "--:--" : remaining > 0 ? duration(remaining) : "Ready"}</p>
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label="Timelock" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

function RefusalWall({ refusal }: { refusal: Refusal }) {
  if (!refusal.code) return <p role="alert" className="text-sm text-muted-foreground">{refusal.message}</p>;
  return (
    <div role="alert" className="rounded-r-lg border-l-[3px] border-destructive bg-destructive-soft px-4 py-3 text-sm">
      <p className="font-medium text-destructive">The chain refused: {refusal.code}</p>
      <p className="text-foreground">{refusal.message}</p>
    </div>
  );
}

function ResultLine({ result }: { result: ActionResult }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 text-sm" data-testid={`${result.kind}-result`}>
      <Check aria-hidden="true" className="size-4 text-success" />
      {result.kind === "propose" ? "Patch proposed. The timelock is running." : "Patch applied to every vault in one transaction."}
      <a href={`${EXPLORER}/tx/${result.hash}`} target="_blank" rel="noreferrer" data-testid={`${result.kind}-tx`} data-hash={result.hash} className="text-primary underline-offset-4 hover:underline">View transaction</a>
    </p>
  );
}

function VaultRow({ vault, factory, current }: { vault: FleetVault; factory: string; current: string | null }) {
  const onCurrent = vault.wasmHash !== null && vault.wasmHash === current;
  const policy = vault.policy;
  return (
    <div role="row" data-testid="fleet-vault" data-address={vault.address} className="grid grid-cols-2 gap-x-4 gap-y-3 border-b px-4 py-4 last:border-b-0 sm:px-6 lg:min-h-table-row lg:grid-cols-[1.4fr_1fr_1.3fr_1fr_1fr] lg:items-center">
      <div role="cell" className="col-span-2 min-w-0 lg:col-span-1">
        <p className="truncate font-medium">{vault.name}</p>
        <details className="mt-1 text-caption">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Vault details</summary>
          <a href={`${EXPLORER}/contract/${vault.address}`} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono hover:text-primary hover:underline">{vault.address}</a>
        </details>
      </div>
      <div role="cell">
        <span className="block text-caption text-muted-foreground lg:hidden">Executable</span>
        {vault.executableRef
          ? <span>{vault.executableRef.owner === factory ? "Factory ref" : "External ref"} <span className="text-caption text-muted-foreground">{vault.executableRef.tag}</span></span>
          : <span className="text-muted-foreground">Own Wasm</span>}
      </div>
      <div role="cell" className="flex flex-wrap items-center gap-2" data-testid="vault-wasm" data-hash={vault.wasmHash ?? ""}>
        <span className="block w-full text-caption text-muted-foreground lg:hidden">Code</span>
        {vault.wasmHash ? <HashChip hash={vault.wasmHash} /> : <span className="text-muted-foreground">Unknown</span>}
        {onCurrent && <Badge variant="success">Current</Badge>}
      </div>
      <div role="cell" data-testid="vault-exposure-caps">
        <span className="block text-caption text-muted-foreground lg:hidden">Exposure caps</span>
        {!policy.registered ? <span className="text-muted-foreground">No policy yet</span>
          : policy.exposureCaps === null ? <span className="text-muted-foreground">not set</span>
            : `${policy.exposureCaps} protocol${policy.exposureCaps === 1 ? "" : "s"}`}
      </div>
      <div role="cell" data-testid="vault-roles">
        <span className="block text-caption text-muted-foreground lg:hidden">Extra roles</span>
        {!policy.registered ? <span className="text-muted-foreground">No policy yet</span>
          : policy.roles === null ? <span className="text-muted-foreground">not set</span>
            : policy.roles.join(", ") || "none"}
      </div>
    </div>
  );
}

function Detail({ label, value, kind }: { label: string; value: string; kind: "account" | "contract" | "tx" }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd><a href={`${EXPLORER}/${kind}/${value}`} target="_blank" rel="noreferrer" className="break-all font-mono text-foreground underline-offset-4 hover:text-primary hover:underline">{value}</a></dd>
    </div>
  );
}
