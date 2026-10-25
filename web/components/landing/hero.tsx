import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { explorerTx, metamaskReport, proofs } from "./data";
import { TxLink } from "./section";

const feed = ["Blend supply", "CallNotAllowed", "DestinationNotVault"].flatMap(name =>
  proofs.filter(item => item.name === name),
);

function GridLines() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden lg:block">
      <div className="absolute inset-y-0 left-1/3 border-l border-dashed" />
      <div className="absolute inset-y-0 left-2/3 border-l border-dashed" />
    </div>
  );
}

function TestnetFeed() {
  return (
    <figure className="rounded-xl border bg-card p-2 shadow-editorial">
      <figcaption className="flex items-center justify-between px-4 pt-3 pb-4 text-caption text-muted-foreground">
        <span>Three calls to one vault</span>
        <span>Stellar testnet</span>
      </figcaption>
      <ol className="space-y-2">
        {feed.map(item => {
          const refused = item.outcome === "refused";
          return (
            <li
              key={item.name}
              className={cn(
                "rounded-lg px-4 py-3",
                refused ? "border-l-[3px] border-destructive bg-destructive-soft" : "bg-muted",
              )}
            >
              <p className="flex items-center justify-between gap-3 text-sm">
                <span className={cn("font-medium", refused ? "text-destructive" : "text-heading")}>
                  {refused ? `Refused · ${item.name}` : `Allowed · ${item.name}`}
                </span>
                {!refused && <span className="size-2 rounded-full bg-success" aria-hidden="true" />}
              </p>
              <p className="mt-1 text-caption leading-relaxed text-muted-foreground">{item.meaning}</p>
              <div className="mt-2">
                {item.txs.map(tx => <TxLink key={tx.hash} hash={tx.hash} href={explorerTx(tx.hash)} />)}
              </div>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden px-6 pt-16 pb-20 sm:px-12 sm:pt-24 lg:pt-32 lg:pb-28">
      <GridLines />
      <div className="relative grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_23rem] lg:gap-16">
        <div>
          <a
            href={metamaskReport}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex flex-wrap items-baseline gap-x-2 text-sm"
          >
            <span className="font-medium text-heading">$204,000 drained from one AI wallet</span>
            <span className="text-muted-foreground">in May 2026</span>
            <span className="text-muted-foreground underline-offset-4 group-hover:text-primary group-hover:underline">
              MetaMask report ↗
            </span>
          </a>
          <h1
            id="hero-title"
            className="mt-8 text-page font-light tracking-tight text-heading sm:text-hero"
          >
            AI agents can be tricked.{" "}
            <span className="text-muted-foreground">Your vault can&apos;t.</span>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Agents propose trades; the chain checks every one. A hijacked agent hits a wall, not your funds.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild size="lg" data-primary>
              <Link href="/agents">Explore agents</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-input">
              <a href="#how-it-works">How the leash works</a>
            </Button>
          </div>
        </div>
        <TestnetFeed />
      </div>
    </section>
  );
}

export { Hero };
