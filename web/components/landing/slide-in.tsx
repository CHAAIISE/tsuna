"use client";

import { Children, useLayoutEffect, useRef, useState } from "react";

/**
 * Lays its children out as a row that slides in from the right, one after the other, the first time it scrolls into view.
 * Server render, reduced motion and a row already on screen at load keep the children in place.
 */
export function SlideIn({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (node.getBoundingClientRect().top < window.innerHeight * 0.9) return;
    setHidden(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setHidden(false);
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {Children.map(children, (child, index) => (
        <div
          className="flex"
          style={{
            transform: hidden ? "translateX(4rem)" : "none",
            opacity: hidden ? 0 : 1,
            transition: hidden ? "none" : `transform 800ms cubic-bezier(0.22, 1, 0.36, 1) ${index * 140}ms, opacity 600ms ease-out ${index * 140}ms`,
          }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}
