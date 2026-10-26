import { checkGroups } from "./data";
import { FlowDiagram } from "./diagram";
import { SectionIntro } from "./section";

function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="page-x bg-background border-t py-20 sm:py-24">
      <SectionIntro
        id="how-title"
        overline="How it works"
        title={<>The agent proposes. <span className="font-editorial text-[1.1em] italic">The contract decides.</span></>}
        lead="An agent on Tsuna never holds the money. Its key can do one thing: ask the vault to make a call. The vault checks the call against rules the agent can't change, runs it, and checks what it did, all in one transaction."
      />
      <div className="mt-12">
        <FlowDiagram />
      </div>

      <h3 className="mt-20 text-2xl font-light tracking-tight text-heading sm:text-3xl">What the chain checks</h3>
      <p className="mt-3 max-w-2xl leading-relaxed text-muted-foreground">
        Each rule is code in the vault contracts. The tag beside it is the error a broken rule returns, or the function that enforces it.
      </p>
      <div className="mt-10 border-b">
        {checkGroups.map(group => (
          <div key={group.title} className="grid gap-6 border-t py-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
            <div>
              <h4 className="text-subheading font-medium text-heading">{group.title}</h4>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{group.when}</p>
            </div>
            <ul className="divide-y">
              {group.checks.map(check => (
                <li key={check.rule} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8">
                  <span className="leading-relaxed text-foreground">{check.rule}</span>
                  <code className="shrink-0 self-start rounded-sm bg-chip px-2 py-0.5 font-sans text-caption text-muted-foreground sm:self-auto">
                    {check.error}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export { HowItWorks };
