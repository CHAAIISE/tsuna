import Link from "next/link";
import { ArrowDown } from "lucide-react";

const docsUrl = "https://github.com/CHAAIISE/leash#readme";

function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative flex min-h-svh flex-col bg-card px-6 py-6 sm:px-10 sm:py-7"
    >
      <header className="flex items-center justify-between">
        <a
          href={docsUrl}
          className="font-display text-sm tracking-[0.18em] text-muted-foreground uppercase transition-colors hover:text-heading"
        >
          Docs
        </a>
        <Link
          href="/agents"
          data-primary
          className="rounded-sm border border-destructive/70 px-5 py-2.5 font-display text-sm tracking-[0.14em] text-destructive uppercase transition-colors hover:bg-destructive hover:text-white sm:px-8 sm:py-3"
        >
          Launch app
        </Link>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <h1
          id="hero-title"
          className="font-display text-[clamp(4rem,15vw,14rem)] leading-none font-medium tracking-[0.16em] text-foreground uppercase [padding-left:0.16em]"
        >
          Leash
        </h1>
        <p className="mt-10 font-editorial text-xl text-muted-foreground italic sm:text-2xl">
          Your agents. The chain&apos;s rules.
        </p>
      </div>

      <a
        href="#product"
        className="mx-auto flex flex-col items-center gap-2 font-display text-xs tracking-[0.3em] text-muted-foreground/70 uppercase transition-colors hover:text-heading"
      >
        Scroll
        <ArrowDown className="size-4" aria-hidden="true" />
      </a>
    </section>
  );
}

export { Hero };
