import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { proofs } from "./data";

const steps = [
  { numeral: "I", title: "Propose", body: "An AI agent with a session key proposes a DeFi move. It never holds the funds." },
  { numeral: "II", title: "Enforce", body: "The vault contract checks it against on-chain guardrails the agent can't touch." },
  { numeral: "III", title: "Settle", body: "Executed and re-checked in one atomic transaction. Anything off: full revert." },
] as const;

const features = [
  { title: "On-chain guardrails", body: "Allowlists, exposure caps and loss budgets live in Soroban, not in a prompt." },
  { title: "Atomic post-checks", body: "Every call is judged by its outcome, inside the same transaction." },
  { title: "Passkey smart accounts", body: "Face ID in, no seed phrase, zero gas." },
  { title: "Oracle-priced NAV", body: "Reflector and Chainlink, cross-checked. No pool-price games." },
  { title: "Pay-per-call agents", body: "x402 and MPP payments, capped by an on-chain spending limit." },
  { title: "Composable DeFi", body: "Blend, DeFindex, Soroswap, Aquarius: one vault, every venue." },
] as const;

function Plate({ src, alt }: { src: string; alt: string }) {
  return (
    <figure className="mx-auto w-full max-w-xl">
      <Image src={src} width={1254} height={1254} sizes="(min-width: 1024px) 36rem, 100vw" alt={alt} className="h-auto w-full rounded-sm shadow-editorial" />
    </figure>
  );
}

const twoColumns = "grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20";

function Flow() {
  return (
    <section id="how" aria-labelledby="how-title" className="page-x border-t bg-background py-20 sm:py-28">
      <div className={twoColumns}>
        <div className="lg:order-last">
          <p className="font-display text-sm tracking-[0.2em] text-primary uppercase">How it works</p>
          <h2 id="how-title" className="mt-5 font-editorial text-5xl leading-[1.05] font-medium text-heading sm:text-6xl">
            The agent proposes. <span className="italic">The chain decides.</span>
          </h2>
          <ol className="mt-10 border-b">
            {steps.map(step => (
              <li key={step.title} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 border-t py-6">
                <span className="font-editorial text-2xl leading-none text-primary italic">{step.numeral}</span>
                <div>
                  <h3 className="font-display text-base tracking-[0.16em] text-heading uppercase">{step.title}</h3>
                  <p className="mt-2 leading-relaxed text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <Plate src="/landing/orbit.jpg" alt="Engraving of a crescent moon held in orbit around a planet, inside a celestial frame." />
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="inside" aria-labelledby="inside-title" className="page-x border-t bg-muted py-20 sm:py-28">
      <div className={twoColumns}>
        <div>
          <p className="font-display text-sm tracking-[0.2em] text-primary uppercase">Inside the vault</p>
          <h2 id="inside-title" className="mt-5 font-editorial text-5xl leading-[1.05] font-medium text-heading sm:text-6xl">
            Built for agents. <span className="italic">Bound by code.</span>
          </h2>
          <ul className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {features.map(feature => (
              <li key={feature.title} className="border-t border-primary/30 pt-5">
                <h3 className="font-display text-sm tracking-[0.16em] text-heading uppercase">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
              </li>
            ))}
          </ul>
        </div>
        <Plate src="/landing/rings.jpg" alt="Engraving of a ringed planet with its moons, inside a celestial frame." />
      </div>
    </section>
  );
}

function ProofTeaser() {
  const refused = proofs.filter(item => item.outcome === "refused").length;
  const allowed = proofs.filter(item => item.outcome === "allowed").length;
  return (
    <section id="proof" aria-labelledby="proof-title" className="page-x border-t bg-background py-20 sm:py-28">
      <div className={twoColumns}>
        <div className="lg:order-last">
          <p className="font-display text-sm tracking-[0.2em] text-primary uppercase">Proof</p>
          <h2 id="proof-title" className="mt-5 font-editorial text-5xl leading-[1.05] font-medium text-heading sm:text-6xl">
            Real attacks. <span className="italic">Refused on‑chain.</span>
          </h2>
          <dl className="mt-10 flex gap-12 border-t pt-8">
            <div>
              <dt className="font-display text-xs tracking-[0.18em] text-muted-foreground uppercase">Refused</dt>
              <dd className="mt-2 font-editorial text-7xl text-primary">{refused}</dd>
            </div>
            <div>
              <dt className="font-display text-xs tracking-[0.18em] text-muted-foreground uppercase">Allowed</dt>
              <dd className="mt-2 font-editorial text-7xl text-heading">{allowed}</dd>
            </div>
          </dl>
          <Link href="/docs#proof" className="mt-10 inline-flex items-center gap-2 font-display text-sm tracking-[0.14em] text-primary uppercase hover:underline">
            Open the receipts <ArrowUpRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
        <Plate src="/landing/stellar-seal.jpg" alt="Engraving of the Stellar emblem struck on a medallion, inside a celestial frame." />
      </div>
    </section>
  );
}

export { Features, Flow, ProofTeaser };
