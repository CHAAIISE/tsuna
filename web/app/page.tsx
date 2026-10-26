import { BuiltOn } from "@/components/landing/built-on";
import { Emblem } from "@/components/landing/emblem";
import { LandingHeader } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Closing, LandingFooter, Limits } from "@/components/landing/limits";
import { Problem } from "@/components/landing/problem";
import { Proof } from "@/components/landing/proof";
import { ProductPreview } from "@/components/landing/product-preview";

function RisingEdge() {
  return (
    <div aria-hidden="true" className="relative h-px bg-foreground">
      <span className="absolute top-1/2 left-1/2 size-3 -translate-1/2 rounded-full border border-foreground bg-background" />
    </div>
  );
}

export default function Home() {
  return (
    <>
      <Hero />
      <div className="relative z-10 bg-background">
        <RisingEdge />
        <div className="mx-auto min-h-screen max-w-site border-x">
          <LandingHeader />
          <main>
            <Emblem />
            <ProductPreview />
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
    </>
  );
}
