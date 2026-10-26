"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";

const links = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#proof", label: "Proof" },
  { href: "#built-on", label: "Built on" },
];

const LETTERS = ["T", "S", "U", "N", "A"];

/**
 * Full-width bar that rides up with the content; its ends are left free for the pinned DOCS and LAUNCH APP.
 * The small wordmark spells itself out once the bar reaches the top, after the big one has been covered.
 */
function LandingHeader() {
  const sentinel = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setDocked(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} aria-hidden="true" className="h-px" />
      <header className="sticky top-0 z-20 -mt-px flex h-[5.5rem] items-center justify-center gap-10 border-b bg-background/90 px-40 backdrop-blur sm:h-[6.25rem] sm:px-56">
        <Link href="/" aria-label="Tsuna home" className="rounded-sm font-display text-xl font-medium tracking-[0.16em] text-foreground sm:text-2xl">
          {LETTERS.map((letter, i) => (
            <span
              key={i}
              aria-hidden="true"
              style={{ transitionDelay: docked ? `${i * 70}ms` : "0ms" }}
              className={cn(
                "inline-block transition-[opacity,transform,filter] duration-500 ease-out",
                docked ? "translate-y-0 opacity-100 blur-0" : "translate-y-2 opacity-0 blur-[2px]",
              )}
            >
              {letter}
            </span>
          ))}
        </Link>
        <nav aria-label="Page sections" className="hidden lg:block">
          <ul className="flex items-center gap-8 text-sm text-muted-foreground">
            {links.map(link => (
              <li key={link.href}>
                <a href={link.href} className="transition-colors hover:text-heading">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
    </>
  );
}

export { LandingHeader };
