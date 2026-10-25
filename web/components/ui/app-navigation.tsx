import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "cn";
import { Logo } from "@/components/logo";

const links = [
  { href: "/agents", label: "Agents" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/create", label: "Create" },
  { href: "/fleet", label: "Fleet" },
  { href: "/bridge", label: "Bridge" },
] as const;

function AppNavigation({ activePath, accountAction }: { activePath: string; accountAction?: ReactNode }) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-app flex-wrap items-center gap-4 px-4 py-4 sm:px-6 lg:flex-nowrap lg:px-0">
        <Link href="/" aria-label="Leash home" className="shrink-0"><Logo /></Link>
        <div className="ml-auto lg:order-last">{accountAction}</div>
        <nav aria-label="Main navigation" className="flex w-full gap-1 overflow-x-auto rounded-full bg-secondary p-1 lg:ml-8 lg:w-auto lg:bg-transparent">
          {links.map(({ href, label }) => {
            const active = activePath === href || activePath.startsWith(`${href}/`);
            return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("flex flex-1 items-center justify-center rounded-full border border-transparent px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-muted focus-visible:outline-ring lg:flex-none lg:px-4", active && "border-input bg-card shadow-card")}>{label}</Link>;
          })}
        </nav>
      </div>
    </header>
  );
}

export { AppNavigation };
