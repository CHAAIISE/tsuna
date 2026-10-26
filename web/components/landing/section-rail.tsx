"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";

const SECTIONS = [
  { id: "idea", label: "The idea" },
  { id: "problem", label: "The problem" },
  { id: "how-it-works", label: "How it works" },
  { id: "proof", label: "Proof" },
  { id: "built-on", label: "Built on" },
  { id: "limits", label: "Limits" },
  { id: "start", label: "Start" },
] as const;

/** Rope-like index on the right edge: shows up once the content has covered the hero and tracks the section in view. */
export function SectionRail() {
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight * 0.85);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    // Pinned pages stay in view under the ones covering them: the current page is the last one in the band.
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        const current = SECTIONS.findLast(section => inBand.has(section.id));
        if (current) setActive(current.id);
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
      // Centred in the gutter between the content's right edge (site width + its 3rem padding) and the viewport edge.
      style={{ right: "calc((100vw - var(--container-site)) / 4 + 1.5rem)" }}
      className={cn(
        "fixed top-1/2 z-30 hidden translate-x-1/2 -translate-y-1/2 transition-[opacity,margin] duration-500 ease-out min-[1400px]:block",
        visible ? "mr-0 opacity-100" : "pointer-events-none -mr-4 opacity-0",
      )}
    >
      <ol className="relative flex flex-col items-center gap-3 py-1">
        <span aria-hidden="true" className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-foreground/25" />
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
                  const page = document.getElementById(section.id);
                  if (!page?.parentElement) return;
                  // A pinned page reports its pinned position: scroll to where it starts in the flow instead.
                  let top = page.parentElement.getBoundingClientRect().top + window.scrollY;
                  for (let sibling = page.previousElementSibling; sibling; sibling = sibling.previousElementSibling) top += (sibling as HTMLElement).offsetHeight;
                  window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
                  history.replaceState(null, "", `#${section.id}`);
                }}
                className="group relative flex size-7 items-center justify-center"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[9px] rounded-full border border-foreground/50 bg-background transition-[opacity,scale] duration-300",
                    current ? "scale-0 opacity-0" : "group-hover:scale-0 group-hover:opacity-0 group-focus-visible:scale-0 group-focus-visible:opacity-0",
                  )}
                />
                <span
                  className={cn(
                    "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 py-1 font-display text-[0.7rem] whitespace-nowrap tracking-[0.18em] uppercase transition-[opacity,scale] duration-300",
                    current
                      ? "scale-100 text-primary opacity-100"
                      : "scale-90 text-heading opacity-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:scale-100 group-focus-visible:opacity-100",
                  )}
                >
                  {section.label}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
