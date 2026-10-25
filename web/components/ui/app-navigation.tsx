"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { AccountAction } from "@/components/vault/account-action";

const links = [
  { href: "/agents", label: "Agents" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/create", label: "Create" },
  { href: "/fleet", label: "Fleet" },
  { href: "/bridge", label: "Bridge" },
] as const;

/** Screen where signing in is the main action for a signed-out visitor; elsewhere the screen has its own. */
const SIGN_IN_SCREEN = "/agents";

/** Header of every app screen: tabs with the current one marked, network badge and passkey account. */
function AppNavigation() {
  const pathname = usePathname();
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-app flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 sm:px-6 lg:flex-nowrap lg:px-0">
        <Link href="/" aria-label="Leash home" className="shrink-0">
          <Logo markOnly className="h-9 sm:hidden" />
          <Logo className="hidden sm:block" />
        </Link>
        <div className="ml-auto flex items-center gap-3 lg:order-last">
          <Badge variant="secondary" title="Every balance here is test USDC with no real value" data-testid="network-badge">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
            <span className="sm:hidden">Testnet</span>
            <span className="hidden sm:inline">Stellar testnet</span>
          </Badge>
          {pathname !== "/onboarding" && <AccountAction primary={pathname === SIGN_IN_SCREEN} />}
        </div>
        <nav aria-label="Main navigation" className="flex w-full gap-1 overflow-x-auto rounded-full bg-secondary p-1 lg:ml-8 lg:w-auto lg:bg-transparent">
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
