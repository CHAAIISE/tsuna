import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { Overline } from "./section";

function Limits() {
  return (
    <section id="limits" aria-labelledby="limits-title" className="page-x border-t bg-muted py-20 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <Overline>Limits</Overline>
          <h2 id="limits-title" className="mt-4 text-3xl font-light tracking-tight text-heading sm:text-[2.5rem] sm:leading-[1.15]">
            What it doesn&apos;t protect against
          </h2>
        </div>
        <div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
          <p>
            Tsuna stops the agent from moving value out of the vault. It can&apos;t make Blend, Soroswap or any
            other protocol unhackable: once funds sit in a protocol, they share its risk.
          </p>
          <p>
            What bounds that loss is the exposure cap on each protocol and the pause when a drawdown passes the limit.
            The agent can also lose money inside its rules, within the per-call tolerance and the daily loss budget.
            Tsuna bounds the worst case; it doesn&apos;t promise returns.
          </p>
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section id="start" aria-labelledby="closing-title" className="page-x bg-background border-t py-20 sm:py-24">
      <h2 id="closing-title" className="max-w-3xl text-3xl font-light tracking-tight text-heading sm:text-[2.5rem] sm:leading-[1.15]">
        Try to break it. <span className="font-editorial text-[1.1em] italic">Create a passkey, get test USDC, and watch the chain say no.</span>
      </h2>
      <div className="mt-10 flex flex-wrap gap-3">
        <Button asChild size="lg" variant="outline" className="border-input">
          <Link href="/agents">Explore agents</Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="border-input">
          <Link href="/onboarding">Create your passkey</Link>
        </Button>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="page-x flex flex-col gap-4 border-t py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <Logo className="h-4" />
      <p>Built on Stellar.</p>
    </footer>
  );
}

export { Closing, LandingFooter, Limits };
