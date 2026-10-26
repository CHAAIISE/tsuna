"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "cn";
import { Logo } from "@/components/logo";
import { AccountAction } from "@/components/vault/account-action";

const links = [
  { href: "/agents", label: "Agents" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/create", label: "Create" },
  { href: "/bridge", label: "Bridge" },
] as const;

/** Screen where signing in is the main action for a signed-out visitor; elsewhere the screen has its own. */
const SIGN_IN_SCREEN = "/agents";

/** Header of every app screen: tabs with the current one marked and the passkey account. */
function AppNavigation() {
  const pathname = usePathname();
  const nav = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const current = links.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`))?.href;
  // The pill leaves on click, not when the next page has loaded; it only applies while still on the page clicked from.
  const [clicked, setClicked] = useState<{ href: string; from: string } | null>(null);
  const active = clicked?.from === pathname ? clicked.href : current;

  // One pill slides under the current tab instead of each tab drawing its own background.
  useLayoutEffect(() => {
    const place = () => {
      const tab = nav.current?.querySelector<HTMLElement>(`[data-href="${active}"]`);
      setPill(tab ? { left: tab.offsetLeft, width: tab.offsetWidth } : null);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [active]);

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-app flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-6 lg:flex-nowrap lg:px-0">
        <Link href="/" aria-label="Tsuna home" className="shrink-0">
          <Logo className="h-4 sm:h-5" />
        </Link>
        <div className="ml-auto flex items-center gap-3 lg:order-last">
          {pathname !== "/onboarding" && <span data-tour="account" className="inline-flex"><AccountAction primary={pathname === SIGN_IN_SCREEN} /></span>}
        </div>
        <nav ref={nav} aria-label="Main navigation" data-tour="nav" className="relative flex w-full gap-1 overflow-x-auto rounded-full bg-secondary p-1 lg:ml-8 lg:w-auto lg:bg-transparent">
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-1 bottom-1 left-0 rounded-full border border-input bg-card shadow-card transition-[transform,width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              !pill && "opacity-0",
            )}
            style={pill ? { width: pill.width, transform: `translateX(${pill.left}px)` } : undefined}
          />
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              data-href={href}
              onClick={() => setClicked({ href, from: pathname })}
              aria-current={href === current ? "page" : undefined}
              className={cn(
                "relative flex flex-1 items-center justify-center rounded-full px-2 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-ring sm:px-3 lg:flex-none lg:px-4",
                href === active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

export { AppNavigation };
