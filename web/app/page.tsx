import { BuiltOn } from "@/components/landing/built-on";
import { Emblem } from "@/components/landing/emblem";
import { LandingHeader } from "@/components/landing/header";
import { Hero, LandingNav } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Closing, LandingFooter, Limits } from "@/components/landing/limits";
import { Problem } from "@/components/landing/problem";
import { Proof } from "@/components/landing/proof";

/** Top edge of the rising content, drawn above the pinned buttons so it sweeps over them. */
function RisingEdge() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-[100svh] z-40 h-px bg-foreground">
      <span className="absolute top-1/2 left-1/2 size-3 -translate-1/2 rounded-full border border-foreground bg-background" />
    </div>
  );
}

export default function Home() {
  return (
    <div className="relative">
      <Hero />
      <LandingNav />
      <RisingEdge />
      <div className="relative z-10 bg-background">
        <LandingHeader />
        <div className="mx-auto min-h-screen max-w-site">
          <main>
            <Emblem />
            <Problem />
            <HowItWorks />
            <Proof />
            <BuiltOn />
            <Limits />
            <Closing />
          </main>
          <LandingFooter />
        </div>
      </div>
    </div>
  );
}
