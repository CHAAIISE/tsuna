"use client";

import { useEffect, useRef } from "react";

/**
 * Turns each landing section into a page that stays pinned while the next one slides over it.
 * A page taller than the viewport pins by its bottom edge (negative top), so it is read in full before being covered.
 * Without JavaScript the sections keep the normal flow.
 */
export function PageStack({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const main = ref.current;
    if (!main) return;
    const pages = [...main.children] as HTMLElement[];
    const place = () => {
      for (const page of pages) {
        page.style.position = "sticky";
        page.style.top = `${Math.min(0, window.innerHeight - page.offsetHeight)}px`;
      }
    };
    place();
    const resize = new ResizeObserver(place);
    for (const page of pages) resize.observe(page);
    window.addEventListener("resize", place);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      for (const page of pages) {
        page.style.removeProperty("position");
        page.style.removeProperty("top");
      }
    };
  }, []);

  return (
    <main ref={ref} className="*:shadow-[0_-24px_48px_-28px_rgb(172_35_50/0.3)]">
      {children}
    </main>
  );
}
