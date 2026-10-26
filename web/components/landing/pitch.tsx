import { cn } from "cn";
import { SlideIn } from "./slide-in";

const steps = [
  { numeral: "I", title: "Propose", body: "An AI agent with a session key proposes a DeFi move. It never holds the funds." },
  { numeral: "II", title: "Enforce", body: "The vault contract checks it against on-chain guardrails the agent can't touch." },
  { numeral: "III", title: "Settle", body: "Executed and re-checked in one atomic transaction. Anything off: full revert." },
] as const;

const callers = [
  { name: "AI agent", detail: "Session key · pays per call (x402)" },
  { name: "You", detail: "Passkey · no seed, no gas" },
] as const;

const venues = [
  { name: "Blend", detail: "Lending" },
  { name: "DeFindex", detail: "Yield vaults" },
  { name: "Soroswap", detail: "Swaps" },
  { name: "Aquarius", detail: "Liquidity" },
] as const;

const stages = [
  { index: "01", label: "Who asks" },
  { index: "02", label: "What decides" },
  { index: "03", label: "Where it goes" },
] as const;

const overline = "font-display text-sm tracking-[0.2em] text-primary uppercase";
const heading = "mt-5 max-w-3xl font-editorial text-5xl leading-[1.05] font-medium text-heading sm:text-6xl";

function Flow() {
  return (
    <section id="how" aria-labelledby="how-title" className="page-x border-t bg-background py-20 sm:py-28">
      <p className={overline}>How it works</p>
      <h2 id="how-title" className={heading}>
        The agent proposes. <span className="italic">The chain decides.</span>
      </h2>
      <SlideIn className="mt-16 grid gap-6 md:grid-cols-3">
        {steps.map(step => (
          <article key={step.title} className="w-full rounded-xl border bg-card p-8 shadow-card sm:p-10">
            <span className="font-editorial text-3xl text-primary italic">{step.numeral}</span>
            <h3 className="mt-8 font-display text-lg tracking-[0.16em] text-heading uppercase">{step.title}</h3>
            <p className="mt-3 leading-relaxed text-muted-foreground">{step.body}</p>
          </article>
        ))}
      </SlideIn>
    </section>
  );
}

function Node({ name, detail, main = false }: { name: string; detail: string; main?: boolean }) {
  return (
    <div
      className={cn(
        "flex h-20 flex-col items-center justify-center rounded-xl border bg-card px-4 text-center shadow-card",
        main && "h-auto border-primary/60 py-8 ring-4 ring-primary/5",
      )}
    >
      <span className={cn("text-heading", main ? "font-display text-2xl tracking-[0.16em] uppercase" : "text-lg font-medium")}>{name}</span>
      <span className="mt-1 text-caption text-muted-foreground">{detail}</span>
    </div>
  );
}

/**
 * Dashed links between the columns. Rows are 80px high with 24px gaps, so on the 392px-high diagram
 * the four venues sit at 40/144/248/352, the two callers at 144/248 and the vault at the middle, 196.
 */
function Links({ side }: { side: "in" | "out" }) {
  const d = side === "in"
    ? "M0 144 H32 M0 248 H32 M32 144 V248 M32 196 H64"
    : "M0 196 H32 M32 40 V352 M32 40 H64 M32 144 H64 M32 248 H64 M32 352 H64";
  return (
    <svg aria-hidden="true" viewBox="0 0 64 392" preserveAspectRatio="none" className="hidden h-[392px] w-full text-primary/60 lg:block">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Schema() {
  return (
    <section id="inside" aria-labelledby="inside-title" className="page-x border-t bg-muted py-20 sm:py-28">
      <p className={overline}>Inside the vault</p>
      <h2 id="inside-title" className={heading}>
        One vault. <span className="italic">Every venue.</span>
      </h2>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
        On-chain guardrails, atomic post-checks and oracle-priced NAV sit between whoever asks and the protocols that hold the money.
      </p>

      <figure className="mt-16">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_4rem_minmax(0,1fr)_4rem_minmax(0,1fr)] lg:items-center lg:gap-0">
          <div className="flex flex-col gap-6">
            {callers.map(caller => <Node key={caller.name} {...caller} />)}
          </div>
          <Links side="in" />
          <Node name="Tsuna" detail="Checks the call · runs it · re-checks the outcome" main />
          <Links side="out" />
          <div className="flex flex-col gap-6">
            {venues.map(venue => <Node key={venue.name} {...venue} />)}
          </div>
        </div>
        <figcaption className="mt-10 hidden grid-cols-[minmax(0,1fr)_4rem_minmax(0,1fr)_4rem_minmax(0,1fr)] text-center lg:grid">
          {stages.map((stage, index) => (
            <span key={stage.index} className={cn("font-display text-xs tracking-[0.18em] text-muted-foreground uppercase", index === 1 && "col-start-3", index === 2 && "col-start-5")}>
              <span className="text-primary">{stage.index}</span> · {stage.label}
            </span>
          ))}
        </figcaption>
      </figure>
    </section>
  );
}

export { Flow, Schema };
