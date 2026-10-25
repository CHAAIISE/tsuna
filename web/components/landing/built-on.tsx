import { bricks, type Brick } from "./data";
import { SectionIntro } from "./section";

const statusLabel: Record<Brick["status"], string> = {
  testnet: "On testnet",
  tested: "Contract tests",
  "in progress": "In progress",
};

function BuiltOn() {
  return (
    <section id="built-on" aria-labelledby="built-on-title" className="scroll-mt-4 border-t px-6 py-20 sm:px-12 sm:py-24">
      <SectionIntro
        id="built-on-title"
        overline="Built on"
        title={<>Composed from Stellar&apos;s live protocols, <span className="text-muted-foreground">checked by one contract.</span></>}
        lead="The status on each line says where it stands today: running on testnet, covered by contract tests, or still being wired in."
      />
      <dl className="mt-14 border-b">
        {bricks.map(brick => (
          <div
            key={brick.name}
            className="grid gap-1 border-t py-5 md:grid-cols-[minmax(0,4fr)_minmax(0,6fr)_minmax(0,2fr)] md:items-baseline md:gap-8"
          >
            <dt className="font-medium text-heading">{brick.name}</dt>
            <dd className="leading-relaxed text-muted-foreground">{brick.role}</dd>
            <dd className="mt-1 text-caption text-muted-foreground md:mt-0 md:text-right">{statusLabel[brick.status]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export { BuiltOn };
