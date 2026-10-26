import Image from "next/image";
import { Taut } from "./taut";

export function Emblem() {
  return (
    <section id="idea" aria-labelledby="emblem-title" className="scroll-mt-4 px-6 py-20 sm:px-12 sm:py-28">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20">
        <div className="max-w-lg">
          <p className="font-display text-sm tracking-[0.2em] text-primary uppercase">Power on a rope</p>
          <h2 id="emblem-title" className="mt-5 font-editorial text-5xl leading-[1.05] font-medium text-heading sm:text-6xl">
            Let the agent fly. <Taut>Keep the rope.</Taut>
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            An AI agent is fast, tireless and easy to fool. Tsuna gives it the whole of DeFi to work with, and
            ties every call to rules written in a Stellar contract. It can chase yield; it cannot carry your funds
            away.
          </p>
        </div>
        <figure className="mx-auto w-full max-w-xl">
          <Image
            src="/landing/winged-lion.jpg"
            width={630}
            height={630}
            alt="Engraving of a winged lion leaping inside a celestial frame."
            className="h-auto w-full rounded-sm shadow-editorial"
            priority={false}
          />
        </figure>
      </div>
    </section>
  );
}
