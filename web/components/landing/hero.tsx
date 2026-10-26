import Link from "next/link";
import { ArrowDown } from "lucide-react";

const docsUrl = "https://github.com/CHAAIISE/tsuna#readme";

function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="sticky top-0 flex h-svh flex-col bg-card px-6 py-6 sm:px-10 sm:py-7"
    >
      <header className="flex h-11 items-center sm:h-12">
        <a
          href={docsUrl}
          className="font-display text-sm tracking-[0.18em] text-muted-foreground uppercase transition-colors hover:text-heading"
        >
          Docs
        </a>
      </header>

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
        href="#product"
        className="hero-scroll-cue mx-auto flex flex-col items-center gap-2 font-display text-xs tracking-[0.3em] text-muted-foreground/70 uppercase transition-colors hover:text-heading"
      >
        Scroll
        <ArrowDown className="size-4" aria-hidden="true" />
      </a>
    </section>
  );
}

/** Stays pinned over the hero and the content that rises over it. */
function LaunchApp() {
  return (
    <Link
      href="/agents"
      data-primary
      className="fixed top-6 right-6 z-30 rounded-sm border border-primary/70 bg-background/90 px-5 py-2.5 font-display text-sm tracking-[0.14em] text-primary uppercase backdrop-blur transition-colors hover:bg-primary hover:text-primary-foreground sm:top-7 sm:right-10 sm:px-8 sm:py-3"
    >
      Launch app
    </Link>
  );
}

export { Hero, LaunchApp };
