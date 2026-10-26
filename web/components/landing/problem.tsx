import { incidents } from "./data";
import { Overline, SectionIntro } from "./section";

function Problem() {
  return (
    <section id="problem" aria-labelledby="problem-title" className="scroll-mt-4 border-t bg-muted px-6 py-20 sm:px-12 sm:py-24">
      <SectionIntro
        id="problem-title"
        overline="The problem"
        title={<>The prompt is not a <span className="text-muted-foreground">security boundary.</span></>}
        lead="Agents that hold money are already being robbed. In each case the safety rules lived in a prompt or on a server, and someone got a sentence in front of the model."
      />
      <ol className="mt-14 border-b">
        {incidents.map(incident => (
          <li
            key={incident.title}
            className="grid gap-4 border-t py-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-12"
          >
            <div>
              <p className="font-editorial text-6xl leading-none font-medium tracking-tight text-heading tabular-nums sm:text-7xl">
                {incident.figure}
              </p>
              <Overline className="mt-4">{incident.date}</Overline>
            </div>
            <div className="max-w-xl md:pt-2">
              <h3 className="text-subheading font-medium text-heading">{incident.title}</h3>
              <p className="mt-2 leading-relaxed text-muted-foreground">{incident.body}</p>
              <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-caption">
                {incident.sources.map(source => (
                  <a
                    key={source.href}
                    href={source.href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground underline underline-offset-4 decoration-border hover:text-primary hover:decoration-primary"
                  >
                    {source.label} ↗
                  </a>
                ))}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export { Problem };
