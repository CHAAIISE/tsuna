import { BuiltOn } from "@/components/landing/built-on";
import { LandingHeader } from "@/components/landing/header";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Closing, LandingFooter, Limits } from "@/components/landing/limits";
import { Problem } from "@/components/landing/problem";
import { Proof } from "@/components/landing/proof";

export default function Home() {
  return (
    <div className="mx-auto min-h-screen max-w-site border-x">
      <LandingHeader />
      <main>
        <Hero />
        <Problem />
        <HowItWorks />
        <Proof />
        <BuiltOn />
        <Limits />
        <Closing />
      </main>
      <LandingFooter />
    </div>
  );
}
