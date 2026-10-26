"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-app flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-6 lg:flex-nowrap lg:px-0">
        <Link href="/" aria-label="Tsuna home" className="shrink-0">
          <Logo className="h-4 sm:h-5" />
        </Link>
        <div className="ml-auto flex items-center gap-3 lg:order-last">
          {pathname !== "/onboarding" && <span data-tour="account" className="inline-flex"><AccountAction primary={pathname === SIGN_IN_SCREEN} /></span>}
        </div>
        <nav aria-label="Main navigation" data-tour="nav" className="flex w-full gap-1 overflow-x-auto rounded-full bg-secondary p-1 lg:ml-8 lg:w-auto lg:bg-transparent">
          {links.map(({ href, label }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("flex flex-1 items-center justify-center rounded-full border border-transparent px-2 py-2 text-sm whitespace-nowrap transition-colors hover:bg-muted focus-visible:outline-ring sm:px-3 lg:flex-none lg:px-4", active && "border-input bg-card shadow-card")}>{label}</Link>;
          })}
        </nav>
      </div>
    </header>
  );
}

export { AppNavigation };
