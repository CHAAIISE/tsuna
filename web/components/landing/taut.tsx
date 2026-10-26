"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Words that start slack, like a loose rope, and snap taut the first time they scroll into view.
 * Server render and reduced motion keep the text tight; only words still below the fold go slack.
 */
export function Taut({ children, className }: { children: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [slack, setSlack] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (node.getBoundingClientRect().top < window.innerHeight * 0.85) return;
    setSlack(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setSlack(false);
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  let index = 0;

  return (
    <span ref={ref} className={className}>
      <span className="sr-only">{children}</span>
      <span aria-hidden="true">
        {children.split(/(\s+)/).map((word, w) => {
          if (/^\s+$/.test(word)) return word;
          return (
            <span key={w} className="inline-block whitespace-nowrap">
              {[...word].map((letter, l) => {
                const i = index++;
                // A fixed wave, so the slack shape is identical on every render.
                const lift = Math.sin(i * 1.3) * 0.22;
                const tilt = Math.sin(i * 0.9 + 1) * 9;
                return (
                  <span
                    key={l}
                    className="inline-block will-change-transform"
                    style={{
                      transform: slack ? `translateY(${lift}em) rotate(${tilt}deg)` : "none",
                      opacity: slack ? 0.3 : 1,
                      transition: slack
                        ? "none"
                        : `transform 900ms cubic-bezier(0.34, 1.56, 0.64, 1) ${100 + i * 22}ms, opacity 500ms ease-out ${60 + i * 22}ms`,
                    }}
                  >
                    {letter}
                  </span>
                );
              })}
            </span>
          );
        })}
      </span>
    </span>
  );
}
