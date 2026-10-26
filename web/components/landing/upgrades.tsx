import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SectionIntro } from "./section";

const points = [
  {
    title: "One shared executable",
    body: "Vaults don't carry their own copy of the code: they point at a reference held by the factory (CAP-85). Moving that reference upgrades every vault in one transaction, with funds and rules untouched.",
  },
  {
    title: "Two keys and a timelock",
    body: "A patch needs both factory admins, then waits 10 minutes in public before it can apply. Nobody can swap a vault's code silently.",
  },
  {
    title: "Protocol watch",
    body: "Each vault records the code hash of every protocol it calls. If Blend or Soroswap upgrades its contract, the vault refuses to call it (ProtocolChanged) until its creator acknowledges the new code.",
  },
] as const;

function Upgrades() {
  return (
    <section id="upgrades" aria-labelledby="upgrades-title" className="page-x border-t bg-background py-20 sm:py-24">
      <SectionIntro
        id="upgrades-title"
        overline="Upgrades"
        title={<>One patch, every vault. <span className="font-editorial text-[1.1em] italic">Never in secret.</span></>}
        lead="What happens when the vault code itself needs a fix, or when a protocol it uses changes under it."
      />
      <dl className="mt-14 border-b">
        {points.map(point => (
          <div key={point.title} className="grid gap-3 border-t py-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
            <dt className="text-subheading font-medium text-heading">{point.title}</dt>
            <dd className="leading-relaxed text-muted-foreground">{point.body}</dd>
          </div>
        ))}
      </dl>
      <Link href="/fleet" className="mt-10 inline-flex items-center gap-2 font-display text-sm tracking-[0.14em] text-primary uppercase hover:underline">
        Open the fleet console <ArrowUpRight aria-hidden="true" className="size-4" />
      </Link>
    </section>
  );
}

export { Upgrades };
