import Link from "next/link";
import { ArrowDown } from "lucide-react";

const docsUrl = "https://github.com/CHAAIISE/tsuna#readme";

function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="sticky top-0 flex h-svh flex-col bg-card px-6 py-6 sm:px-10 sm:py-7"
    >
      <div aria-hidden="true" className="h-11 sm:h-12" />

      <div className="hero-recede flex flex-1 flex-col items-center justify-center text-center">
        <h1
          id="hero-title"
          className="font-display text-[clamp(4rem,15vw,14rem)] leading-none font-medium tracking-[0.16em] text-foreground uppercase [padding-left:0.16em]"
        >
          Tsuna
        </h1>
        <p className="mt-10 font-editorial text-xl text-muted-foreground italic sm:text-2xl">
          Your agents. The chain&apos;s rules.
        </p>
      </div>

      <a
        href="#idea"
        className="hero-scroll-cue mx-auto flex flex-col items-center gap-2 font-display text-xs tracking-[0.3em] text-muted-foreground/70 uppercase transition-colors hover:text-heading"
      >
        Scroll
        <ArrowDown className="size-4" aria-hidden="true" />
      </a>
    </section>
  );
}

/** DOCS and LAUNCH APP stay pinned over the hero and over the content that rises over it. */
function LandingNav() {
  return (
    <nav aria-label="Site" className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-center justify-between px-6 pt-6 sm:px-10 sm:pt-7">
      <a
        href={docsUrl}
        className="pointer-events-auto rounded-sm bg-background/80 px-2 py-1 font-display text-sm tracking-[0.18em] text-muted-foreground uppercase backdrop-blur transition-colors hover:text-heading"
      >
        Docs
      </a>
      <Link
        href="/agents"
        data-primary
        className="pointer-events-auto rounded-sm border border-primary/70 bg-background/90 px-5 py-2.5 font-display text-sm tracking-[0.14em] text-primary uppercase backdrop-blur transition-colors hover:bg-primary hover:text-primary-foreground sm:px-8 sm:py-3"
      >
        Launch app
      </Link>
    </nav>
  );
}

export { Hero, LandingNav };
