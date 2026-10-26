"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fetchJson } from "@/lib/hooks/fetch-json";
import { useVault } from "@/lib/hooks/use-vault";
import type { AttackCatalog, AttackRun } from "@/lib/stellar/attack-types";
import { TsunaRules } from "@/components/vault/rules";
import wall from "@/components/vault/wall.module.css";
import { RevokeSession } from "./revoke-session";

const explanations: Record<string, string> = {
  CallNotAllowed: "The agent cannot call the USDC transfer function.",
  DestinationNotVault: "The money must return to the vault, never to the attacker.",
  NavDropped: "The call passed the allowlist, but moving the shares would lower the vault's value. The entire transaction was rolled back.",
  AssetNotAllowed: "Every token in the swap route must be allowed. The attacker's token is not.",
};

export function AttackLab({ id }: { id: string }) {
  const [tab, setTab] = useState<"attacks" | "rules">("attacks");
  const vault = useVault(id);
  const client = useQueryClient();
  const catalog = useQuery({
    queryKey: ["attack-lab"],
    queryFn: () => fetchJson<AttackCatalog>("/api/attack"),
    refetchInterval: query => query.state.data?.runs.some(run => run.status === "running") ? 2_000 : false,
  });
  const launch = useMutation({
    mutationFn: (attack: string) => fetchJson<{ run: AttackRun }>("/api/attack", { action: "launch", attack }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["attack-lab"] }); },
  });
  const running = launch.isPending || !!catalog.data?.runs.some(run => run.status === "running");
  const attacks = catalog.data?.attacks ?? [];
  const primaryAttack = attacks.find(attack => !catalog.data?.runs.find(run => run.attack === attack.id)?.result?.blocked)?.id ?? attacks[0]?.id;
  return <div className="space-y-8">
    <header className="space-y-3">
      <Link href={`/agents/${encodeURIComponent(id)}`} className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"><ArrowLeft aria-hidden="true" className="size-3" />Back to vault</Link>
      <h1 className="text-page font-normal tracking-tight">Try to break it</h1>
      <p className="text-base text-muted-foreground">Each attack is a real transaction. The chain decides.</p>
    </header>
    <div role="tablist" aria-label="Attack lab sections" className="flex w-fit gap-1 rounded-full bg-secondary p-1 text-sm">
      {([['attacks', 'Attack lab'], ['rules', 'Tsuna rules']] as const).map(([key, label]) => <button key={key} role="tab" id={`attack-tab-${key}`} aria-selected={tab === key} aria-controls={`attack-panel-${key}`} onClick={() => setTab(key)} className={`rounded-full border px-4 py-1.5 ${tab === key ? "border-input bg-card shadow-card" : "border-transparent text-muted-foreground"}`}>{label}</button>)}
    </div>
    {tab === "attacks" ? <div id="attack-panel-attacks" role="tabpanel" aria-labelledby="attack-tab-attacks" className="space-y-6">
      <div className="rounded-xl border bg-muted px-6 py-4 text-sm text-muted-foreground">This lab uses the demo fleet: Prudent for four attacks, Leverage for the fake-token route. Results name the vault actually attacked. Only the prompt injection asks the model to choose a call; the other attacks are crafted transactions.</div>
      {catalog.isPending && <div role="status" className="space-y-3 rounded-xl border bg-card p-6"><p className="text-sm text-muted-foreground">Loading the attack scenarios…</p><Button data-primary pending>Loading scenarios…</Button></div>}
      {catalog.error && <div role="alert" className="space-y-3 rounded-xl border bg-card p-6"><p className="text-sm text-muted-foreground">{attacks.length ? "The latest attack results could not be refreshed. The last available scenarios are shown below." : "The attack scenarios could not be loaded. Try reading them again."}</p><Button variant={attacks.length ? "outline" : "default"} data-primary={attacks.length ? undefined : true} pending={catalog.isFetching} onClick={() => void catalog.refetch()}>Try again</Button></div>}
      {!catalog.isPending && !catalog.error && !attacks.length && <div className="space-y-3 rounded-xl border bg-card p-6"><p className="text-sm text-muted-foreground">No attack scenarios are available right now.</p><Button data-primary pending={catalog.isFetching} onClick={() => void catalog.refetch()}>Refresh scenarios</Button></div>}
      {launch.error && <p role="alert" className="text-sm text-muted-foreground">{launch.error.message}</p>}
      <div className="space-y-4">
        {attacks.map((attack, index) => {
          const run = catalog.data?.runs.find(entry => entry.attack === attack.id);
          const result = run?.result;
          return <Card key={attack.id} data-testid={`attack-${attack.id}`}>
            <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-6">
              <div className="min-w-0 space-y-2">
                <p className="text-caption text-muted-foreground">0{index + 1} · Agent {attack.vault === "prudent" ? "Prudent" : "Leverage"}</p>
                <h2 className="text-subheading font-medium">{attack.title}</h2>
                <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{attack.description}</p>
              </div>
              <Button className="shrink-0" variant={attack.id === primaryAttack ? "default" : "outline"} data-primary={attack.id === primaryAttack ? true : undefined} pending={run?.status === "running" || (launch.isPending && launch.variables === attack.id)} disabled={running} onClick={() => launch.mutate(attack.id)}>{run?.status === "running" || (launch.isPending && launch.variables === attack.id) ? "Waiting for Stellar…" : result ? "Replay attack" : "Launch attack"}</Button>
            </div>
            {run?.status === "failed" && <p role="alert" className="px-6 pb-6 text-sm text-muted-foreground">{run.error}</p>}
            {result && <div className="px-4 pb-4 sm:px-6 sm:pb-6" aria-live="polite">
              <div data-testid="attack-wall" data-blocked={result.blocked} data-hash={result.hash} className={result.blocked ? `${wall.wall} space-y-3 rounded-lg border-l-4 border-destructive bg-destructive-soft p-4` : "space-y-3 rounded-lg border p-4"}>
                <p className={`flex items-start gap-2 font-medium break-words ${result.blocked ? "text-destructive" : "text-foreground"}`}><ShieldX aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words">{result.blocked ? `Blocked on-chain · ${result.error}` : `Unexpected outcome · ${result.error ?? result.onChain}`}</span></p>
                <p className="text-sm">{result.blocked ? explanations[result.error ?? ""] : "The transaction did not produce the expected refusal. Inspect the receipt before replaying."}</p>
                <p className="text-caption text-muted-foreground">{result.id === "injection" ? result.note : "Crafted transaction signed with the agent's session key. No model involved."}</p>
                <a data-testid="attack-tx" href={result.explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">View transaction<ArrowUpRight aria-hidden="true" className="size-3" /></a>
                <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">Details</summary><dl className="mt-3 space-y-2 break-all"><dt>Vault</dt><dd>{result.vault.name} · <span className="font-mono">{result.vault.address}</span></dd><dt>Transaction hash</dt><dd className="font-mono">{result.hash}</dd><dt>Expected / decoded error</dt><dd>{result.expected} / {result.error ?? "Unknown"}</dd><dt>RPC status / call chosen by</dt><dd>{result.onChain} / {result.origin === "model" ? "The model" : "The attacker"}</dd><dt>Submitted attempt</dt><dd>{result.note}</dd></dl></details>
              </div>
            </div>}
          </Card>;
        })}
      </div>
      {vault.data && <RevokeSession vault={vault.data} disabled={running} />}
      {vault.error && <p role="alert" className="text-sm text-muted-foreground">The selected vault&apos;s session state could not be read. <button className="underline" onClick={() => void vault.refetch()}>Read again</button></p>}
    </div> : <div id="attack-panel-rules" role="tabpanel" aria-labelledby="attack-tab-rules" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Rules and live budgets for {vault.data?.name ?? "the selected vault"}.</p><Button data-primary pending={vault.isFetching} onClick={() => void vault.refetch()}>{vault.error ? "Try reading rules again" : "Refresh rules"}</Button></div>
      {vault.error && <p role="alert" className="text-sm text-muted-foreground">{vault.data ? "The latest rules could not be read. The last available rules are shown below; refresh before relying on their budgets." : "The vault rules could not be read. Try reading them again."}</p>}
      {vault.data ? <TsunaRules vault={vault.data} /> : !vault.error && <p role="status" className="text-sm text-muted-foreground">Reading on-chain rules…</p>}
    </div>}
  </div>;
}
