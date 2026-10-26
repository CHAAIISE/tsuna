import { BuiltOn } from "@/components/landing/built-on";
import { Emblem } from "@/components/landing/emblem";
import { Hero, LandingNav } from "@/components/landing/hero";
import { PageStack } from "@/components/landing/page-stack";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Closing, LandingFooter, Limits } from "@/components/landing/limits";
import { Problem } from "@/components/landing/problem";
import { Proof } from "@/components/landing/proof";
import { SectionRail } from "@/components/landing/section-rail";

function RisingEdge() {
  return (
    <div aria-hidden="true" className="relative h-px bg-foreground">
      <span className="absolute top-1/2 left-1/2 size-3 -translate-1/2 rounded-full border border-foreground bg-background" />
    </div>
  );
}

export default function Home() {
  return (
    <div className="relative">
      <Hero />
      {/* Left half of the rising edge, redrawn above the pinned DOCS link so the line sweeps across it; LAUNCH APP stays on top. */}
      <div aria-hidden="true" className="pointer-events-none absolute top-[100svh] left-0 z-40 h-px w-1/2 bg-foreground" />
      <LandingNav />
      <SectionRail />
      <div className="relative z-10 bg-background">
        <RisingEdge />
        <PageStack>
          <Emblem />
          <Problem />
          <HowItWorks />
          <Proof />
          <BuiltOn />
          <Limits />
          <Closing />
        </PageStack>
        <LandingFooter />
      </div>
    </div>
  );
}
