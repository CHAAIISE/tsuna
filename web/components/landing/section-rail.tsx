"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";

const SECTIONS = [
  { id: "idea", numeral: "I", label: "The idea" },
  { id: "product", numeral: "II", label: "The vault" },
  { id: "problem", numeral: "III", label: "The problem" },
  { id: "how-it-works", numeral: "IV", label: "How it works" },
  { id: "proof", numeral: "V", label: "Proof" },
  { id: "built-on", numeral: "VI", label: "Built on" },
  { id: "limits", numeral: "VII", label: "Limits" },
  { id: "start", numeral: "VIII", label: "Start" },
] as const;

/** Rope-like index on the right edge: shows up once the content has covered the hero and tracks the section in view. */
export function SectionRail() {
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight * 0.85);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const observer = new IntersectionObserver(
      entries => {
        const inView = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (inView[0]) setActive(inView[0].target.id);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const { id } of SECTIONS) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => {
      window.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  return (
    <nav
      aria-label="Landing sections"
      className={cn(
        "fixed top-1/2 right-6 z-30 hidden -translate-y-1/2 transition-[opacity,transform] duration-500 ease-out xl:block",
        visible ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-4 opacity-0",
      )}
    >
      <ol className="relative flex flex-col gap-5 py-2">
        <span aria-hidden="true" className="absolute top-0 right-[5.5px] bottom-0 w-px translate-x-1/2 bg-foreground/25" />
        {SECTIONS.map(section => {
          const current = section.id === active;
          return (
            <li key={section.id} className="relative">
              <a
                href={`#${section.id}`}
                aria-current={current ? "location" : undefined}
                onClick={event => {
                  event.preventDefault();
                  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                  document.getElementById(section.id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
                  history.replaceState(null, "", `#${section.id}`);
                }}
                className="group flex items-center justify-end gap-3"
              >
                <span
                  className={cn(
                    "font-display text-[0.7rem] tracking-[0.2em] uppercase transition-all duration-300",
                    current
                      ? "translate-x-0 text-primary opacity-100"
                      : "translate-x-2 text-muted-foreground opacity-0 group-hover:translate-x-0 group-hover:opacity-100",
                  )}
                >
                  <span className="mr-2 font-editorial text-sm tracking-normal normal-case italic">{section.numeral}</span>
                  {section.label}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative z-10 size-[11px] shrink-0 rounded-full border transition-colors duration-300",
                    current ? "border-primary bg-primary" : "border-foreground/50 bg-background group-hover:border-primary",
                  )}
                />
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
