"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DAILY_LOSS_OPTIONS, DRAWDOWN_OPTIONS, EXPOSURE_OPTIONS, STRATEGIES,
  type CreateChoice, type Option, type PresetInfo, type StrategyId,
} from "@/lib/fleet/strategies";

const EXPLORER = "https://stellar.expert/explorer/testnet";
const STEPS = ["Strategy", "Tsuna rules", "Review"] as const;

interface Published {
  vault: string;
  creator: string;
  deployTx: string;
  registerTx: string;
  adapterTxs: string[];
}

const label = <T extends string | number>(options: Option<T>[], value: T) => options.find(option => option.value === value)?.label ?? String(value);

function Steps({ current }: { current: number }) {
  return (
    <nav aria-label="Publishing steps" data-testid="create-steps" className="rounded-xl border bg-card px-4 py-4 sm:px-6">
      <ol className="grid grid-cols-3 gap-2 sm:gap-4">
        {STEPS.map((name, index) => (
          <li key={name} aria-current={index === current ? "step" : undefined} className="flex items-center gap-2 text-caption sm:gap-3">
            <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border font-medium", index === current ? "border-primary bg-primary text-primary-foreground" : index < current ? "border-primary/20 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>
              {index < current ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={cn(index > current && "text-muted-foreground")}>{name}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Choices<T extends string | number>({ name, legend, hint, options, value, onChange }: {
  name: string; legend: string; hint: string; options: Option<T>[]; value: T; onChange: (value: T) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium">{legend}</legend>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        {options.map(option => (
          <label key={String(option.value)} className={cn("cursor-pointer rounded-full border px-4 py-2 text-sm transition-colors hover:bg-secondary has-focus-visible:ring-3 has-focus-visible:ring-ring/50", value === option.value && "border-primary bg-primary/5 text-foreground")}>
            <input type="radio" name={name} className="sr-only" checked={value === option.value} onChange={() => onChange(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateFlow({ presets, creator }: { presets: Record<string, PresetInfo>; creator: string | null }) {
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<CreateChoice>({
    strategy: "yield",
    venues: STRATEGIES[0]?.venues.map(venue => venue.id) ?? [],
    dailyLossBps: 50,
    drawdownBps: 2_000,
    exposure: "vault",
    riskOff: false,
  });
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<Published | null>(null);

  const strategy = STRATEGIES.find(item => item.id === choice.strategy) ?? STRATEGIES[0];
  if (!strategy) return null;
  const venues = strategy.venues.filter(venue => !venue.optional || choice.venues.includes(venue.id));
  const update = (patch: Partial<CreateChoice>) => setChoice(current => ({ ...current, ...patch }));

  function pickStrategy(id: StrategyId) {
    const next = STRATEGIES.find(item => item.id === id);
    if (next) update({ strategy: id, venues: next.venues.map(venue => venue.id) });
  }

  function toggleVenue(id: string) {
    const enabled = choice.venues.includes(id);
    if (enabled && venues.length === 1) return;
    update({ venues: enabled ? choice.venues.filter(venue => venue !== id) : [...choice.venues, id] });
  }

  async function publish() {
    setPublishing(true);
    setError(null);
    try {
      const response = await fetch("/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(choice),
      });
      const body = await response.json() as Published & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Publishing failed (${response.status}).`);
      setPublished(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Publishing failed.");
    } finally {
      setPublishing(false);
    }
  }

  if (published) {
    const txs = [
      { label: "Vault deployed by the factory", hash: published.deployTx },
      { label: "Tsuna rules registered", hash: published.registerTx },
      ...published.adapterTxs.map((hash, index) => ({ label: `${venues[index]?.label ?? "Protocol"} position tracking`, hash })),
    ];
    return (
      <Card data-testid="create-published" data-vault={published.vault}>
        <CardHeader>
          <Badge variant="success" className="w-fit">Published on Stellar</Badge>
          <CardTitle>Your {strategy.label.toLowerCase()} agent has a vault</CardTitle>
          <CardDescription>
            Your vault runs the factory&apos;s shared code and its rules are in force.
            It takes deposits now; its agent acts within the rules you chose.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <details className="text-caption">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
            <dl className="mt-3 space-y-3">
              {[{ label: "Vault", value: published.vault, kind: "contract" }, { label: "Creator", value: published.creator, kind: "account" },
                ...txs.map(tx => ({ label: tx.label, value: tx.hash, kind: "tx" }))].map(row => (
                <div key={row.value} className="space-y-1">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd><a data-testid={row.value === published.vault ? "created-vault" : undefined} href={`${EXPLORER}/${row.kind}/${row.value}`} target="_blank" rel="noreferrer" className="break-all font-mono text-foreground underline-offset-4 hover:text-primary hover:underline">{row.value}</a></dd>
                </div>
              ))}
            </dl>
          </details>
        </CardContent>
        <CardFooter>
          <Button data-primary asChild><Link href="/fleet">See it in the fleet</Link></Button>
          <Button variant="outline" asChild><Link href="/agents">Browse agents</Link></Button>
        </CardFooter>
      </Card>
    );
  }

  const riskOff = presets.riskOff;
  return (
    <div className="space-y-6">
      <Steps current={step} />
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>What should the agent do?</CardTitle>
            <CardDescription>Each strategy maps to protocol actions with safe defaults. You choose the limits next.</CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset className="grid gap-3 lg:grid-cols-3">
              <legend className="sr-only">Strategy</legend>
              {STRATEGIES.map(item => (
                <label key={item.id} data-testid={`strategy-${item.id}`} className={cn("flex cursor-pointer flex-col gap-2 rounded-lg border p-4 transition-colors hover:bg-secondary has-focus-visible:ring-3 has-focus-visible:ring-ring/50 sm:gap-3", item.id === choice.strategy && "border-primary bg-primary/5")}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.label}</span>
                    <input type="radio" name="strategy" checked={item.id === choice.strategy} onChange={() => pickStrategy(item.id)} className="accent-primary" />
                  </span>
                  <span className="text-sm text-muted-foreground">{item.summary}</span>
                  <span className="mt-auto flex flex-wrap gap-1.5">
                    {item.venues.map(venue => <Badge key={venue.id} variant="secondary" className="px-2 py-1 text-caption">{venue.adapter}</Badge>)}
                  </span>
                </label>
              ))}
            </fieldset>
          </CardContent>
          <CardFooter>
            <Button data-primary onClick={() => setStep(1)}>Next: Tsuna rules</Button>
          </CardFooter>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Tsuna rules</CardTitle>
            <CardDescription>Composed from the SDK&apos;s protocol presets. The chain refuses any call outside them, whatever the agent is told.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 sm:space-y-8">
            <fieldset className="space-y-3">
              <legend className="font-medium">Protocols the agent may use</legend>
              <p className="text-sm text-muted-foreground">Keep at least one protocol enabled. Required protocols cannot be removed.</p>
              {strategy.venues.map(venue => {
                const enabled = venues.includes(venue);
                return (
                  <label key={venue.id} className={cn("flex items-start gap-3 rounded-lg border p-4", venue.optional ? "cursor-pointer hover:bg-secondary" : "bg-secondary/40")}>
                    <input type="checkbox" checked={enabled} disabled={!venue.optional || (enabled && venues.length === 1)} onChange={() => toggleVenue(venue.id)} className="mt-1 accent-primary" />
                    <span className="min-w-0 space-y-1">
                      <span className="block font-medium">{venue.label}{!venue.optional && <span className="ml-2 text-caption font-normal text-muted-foreground">Required by this strategy</span>}</span>
                      {venue.presets.map(id => presets[id]).filter(preset => preset !== undefined).map(preset => (
                        <span key={preset.id} className="block text-sm text-muted-foreground"><span className="text-foreground">{preset.label}:</span> {preset.description}</span>
                      ))}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="grid gap-6 sm:gap-8 lg:grid-cols-3">
              <Choices name="daily-loss" legend="Loss budget per day" hint="Above this loss over 24 h, every further call is refused." options={DAILY_LOSS_OPTIONS} value={choice.dailyLossBps} onChange={dailyLossBps => update({ dailyLossBps })} />
              <Choices name="drawdown" legend="Pause on drawdown" hint="Anyone can pause the vault once its share price falls this far from its 24 h peak." options={DRAWDOWN_OPTIONS} value={choice.drawdownBps} onChange={drawdownBps => update({ drawdownBps })} />
              <Choices name="exposure" legend="Exposure" hint="How much of the vault one protocol may hold." options={EXPOSURE_OPTIONS} value={choice.exposure} onChange={exposure => update({ exposure })} />
            </div>
            {riskOff && (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 hover:bg-secondary" data-testid="risk-off-option">
                <input type="checkbox" checked={choice.riskOff} onChange={event => update({ riskOff: event.target.checked })} className="mt-1 accent-primary" />
                <span className="space-y-1">
                  <span className="block font-medium">Add a risk-off agent</span>
                  <span className="block text-sm text-muted-foreground">{riskOff.description}</span>
                </span>
              </label>
            )}
          </CardContent>
          <CardFooter>
            <Button data-primary onClick={() => setStep(2)}>Next: Review</Button>
            <Button variant="outline" onClick={() => setStep(0)}>Back</Button>
          </CardFooter>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>Publishing deploys the vault through the Tsuna factory and registers these rules before any deposit.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y rounded-lg border text-sm">
              <ReviewRow term="Strategy" detail={strategy.label} />
              <ReviewRow term="Allowed actions" detail={venues.flatMap(venue => venue.presets).map(id => presets[id]?.label ?? id).join(" · ")} />
              <ReviewRow term="Assets" detail={strategy.assets.join(", ")} />
              <ReviewRow term="Loss per call" detail={strategy.volatile ? "At most 0.5 % (a volatile asset is involved)" : "At most 0.1 % (stablecoins only)"} />
              <ReviewRow term="Loss budget per day" detail={label(DAILY_LOSS_OPTIONS, choice.dailyLossBps)} />
              <ReviewRow term="Pause on drawdown" detail={label(DRAWDOWN_OPTIONS, choice.drawdownBps)} />
              <ReviewRow term="Exposure" detail={label(EXPOSURE_OPTIONS, choice.exposure)} />
              {strategy.borrows && <ReviewRow term="Health factor floor" detail="1.3: a borrow that leaves it lower is refused" />}
              <ReviewRow term="Risk-off agent" detail={choice.riskOff ? "Yes: may only unwind, even while paused" : "No"} />
              <ReviewRow term="Withdrawals" detail="Always open to depositors, even while paused" />
            </dl>
            {error && <p role="alert" className="mt-4 text-sm text-muted-foreground">{error}</p>}
            {!creator && <p id="publish-unavailable" className="mt-4 text-sm text-muted-foreground">Publishing is unavailable because this server has no demo creator configured. You can still edit your rules or browse existing agents.</p>}
          </CardContent>
          <CardFooter>
            <Button data-primary pending={publishing} disabled={!creator} aria-describedby={!creator ? "publish-unavailable" : undefined} onClick={() => void publish()}>
              {publishing ? "Waiting for Stellar…" : "Publish"}
            </Button>
            <Button variant="outline" disabled={publishing} onClick={() => setStep(1)}>Back</Button>
            {creator && <span className="text-caption text-muted-foreground">Signed by the demo creator; fees paid by Tsuna.</span>}
          </CardFooter>
          {creator && (
            <CardContent>
              <details className="text-caption">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Creator details</summary>
                <a href={`${EXPLORER}/account/${creator}`} target="_blank" rel="noreferrer" className="mt-3 block break-all font-mono hover:text-primary hover:underline">{creator}</a>
              </details>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

function ReviewRow({ term, detail }: { term: string; detail: string }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{term}</dt>
      <dd>{detail}</dd>
    </div>
  );
}
