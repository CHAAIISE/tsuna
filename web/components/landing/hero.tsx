import Link from "next/link";
import { ArrowDown } from "lucide-react";

function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="sticky top-0 flex h-svh flex-col bg-card bg-[radial-gradient(ellipse_55%_40%_at_50%_48%,rgb(172_35_50/0.09),transparent_70%)] px-6 py-6 sm:px-10 sm:py-7"
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

/** The left link (DOCS on the landing, HOME on the docs) and LAUNCH APP stay pinned over the page. */
function LandingNav({ href = "/docs", label = "Docs" }: { href?: string; label?: string }) {
  return (
    <nav aria-label="Site" className="pointer-events-none fixed inset-x-0 top-0 z-30 flex items-center justify-between px-6 pt-6 sm:px-10 sm:pt-7">
      <Link
        href={href}
        className="pointer-events-auto rounded-sm px-2 py-1 font-display text-sm tracking-[0.18em] text-muted-foreground uppercase transition-colors hover:text-heading"
      >
        {label}
      </Link>
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
