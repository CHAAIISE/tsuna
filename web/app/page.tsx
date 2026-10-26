import { Emblem } from "@/components/landing/emblem";
import { Hero, LandingNav } from "@/components/landing/hero";
import { Closing, LandingFooter } from "@/components/landing/limits";
import { PageStack } from "@/components/landing/page-stack";
import { Flow, Schema } from "@/components/landing/pitch";
import { SectionRail } from "@/components/landing/section-rail";

const sections = [
  { id: "idea", label: "The idea" },
  { id: "how", label: "How it works" },
  { id: "inside", label: "Inside" },
  { id: "start", label: "Start" },
] as const;

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
      <SectionRail sections={sections} label="Landing sections" revealAfter={0.85} />
      <div className="relative z-10 bg-background">
        <RisingEdge />
        <PageStack>
          <Emblem />
          <Flow />
          <Schema />
          <Closing />
        </PageStack>
        <LandingFooter />
      </div>
    </div>
  );
}
