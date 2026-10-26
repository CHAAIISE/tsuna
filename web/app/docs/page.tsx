import type { Metadata } from "next";
import { ArrowUpRight } from "lucide-react";
import { BuiltOn } from "@/components/landing/built-on";
import { LandingNav } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LandingFooter, Limits } from "@/components/landing/limits";
import { Problem } from "@/components/landing/problem";
import { Proof } from "@/components/landing/proof";
import { SectionRail } from "@/components/landing/section-rail";
import { Upgrades } from "@/components/landing/upgrades";

export const metadata: Metadata = {
  title: "Docs — Tsuna",
  description: "How Tsuna keeps AI agents on a rope: the threat, every check the Stellar contract runs, the on-chain receipts, the stack and the limits.",
};

const sections = [
  { id: "problem", label: "The problem" },
  { id: "how-it-works", label: "How it works" },
  { id: "proof", label: "Proof" },
  { id: "built-on", label: "Built on" },
  { id: "upgrades", label: "Upgrades" },
  { id: "limits", label: "Limits" },
] as const;

export default function Docs() {
  return (
    <>
      <LandingNav href="/" label="Home" />
      <SectionRail sections={sections} label="Docs sections" />
      <header className="page-x bg-card pt-36 pb-16 sm:pt-44 sm:pb-20">
        <p className="font-display text-sm tracking-[0.2em] text-primary uppercase">Docs</p>
        <h1 className="mt-5 max-w-3xl font-editorial text-5xl leading-[1.05] font-medium text-heading sm:text-7xl">
          How Tsuna keeps agents <span className="italic">on a rope.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
          The threat, every check the vault contract runs, the transactions that prove it, the protocols it composes, how its code is upgraded and what it does not cover.
        </p>
        <a
          href="https://github.com/CHAAIISE/tsuna#readme"
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex items-center gap-2 font-display text-sm tracking-[0.14em] text-primary uppercase hover:underline"
        >
          Source code and README <ArrowUpRight aria-hidden="true" className="size-4" />
        </a>
      </header>
      <main>
        <Problem />
        <HowItWorks />
        <Proof />
        <BuiltOn />
        <Upgrades />
        <Limits />
      </main>
      <LandingFooter />
    </>
  );
}
