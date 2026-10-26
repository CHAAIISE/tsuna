import { BuiltOn } from "@/components/landing/built-on";
import { LandingHeader } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Closing, LandingFooter, Limits } from "@/components/landing/limits";
import { Problem } from "@/components/landing/problem";
import { Proof } from "@/components/landing/proof";
import { ProductPreview } from "@/components/landing/product-preview";

export default function Home() {
  return (
    <>
      <Hero />
      <div className="mx-auto min-h-screen max-w-site border-x">
        <LandingHeader />
        <main>
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
    </>
  );
}
