import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { Overline } from "./section";

function Limits() {
  return (
    <section aria-labelledby="limits-title" className="border-t bg-muted px-6 py-20 sm:px-12 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <Overline>Limits</Overline>
          <h2 id="limits-title" className="mt-4 text-3xl font-light tracking-tight text-heading sm:text-[2.5rem] sm:leading-[1.15]">
            What it doesn&apos;t protect against
          </h2>
        </div>
        <div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
          <p>
            The leash stops the agent from moving value out of the vault. It can&apos;t make Blend, Soroswap or any
            other protocol unhackable: once funds sit in a protocol, they share its risk.
          </p>
          <p>
            What bounds that loss is the exposure cap on each protocol and the pause when a drawdown passes the limit.
            The agent can also lose money inside its rules, within the per-call tolerance and the daily loss budget.
            Leash bounds the worst case; it doesn&apos;t promise returns.
          </p>
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section aria-labelledby="closing-title" className="border-t px-6 py-20 sm:px-12 sm:py-24">
      <h2 id="closing-title" className="max-w-3xl text-3xl font-light tracking-tight text-heading sm:text-[2.5rem] sm:leading-[1.15]">
        Try to break it. <span className="text-muted-foreground">Create a passkey, get test USDC, and watch the chain say no.</span>
      </h2>
      <div className="mt-8">
        <OnboardingSteps currentStep={0} />
      </div>
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
    <footer className="flex flex-col gap-4 border-t px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-12">
      <Logo className="h-7" />
      <p>Stellar testnet only. Every balance here is test USDC with no real value.</p>
    </footer>
  );
}

export { Closing, LandingFooter, Limits };
