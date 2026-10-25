import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

const links = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#proof", label: "Proof" },
  { href: "#built-on", label: "Built on" },
];

function LandingHeader() {
  return (
    <header className="flex items-center justify-between gap-6 border-b px-6 py-5 sm:px-12">
      <Link href="/" aria-label="Leash home" className="rounded-sm">
        <Logo className="h-9" />
      </Link>
      <nav aria-label="Page sections" className="hidden md:block">
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
      <Button asChild variant="outline" className="border-input">
        <Link href="/onboarding">Launch app</Link>
      </Button>
    </header>
  );
}

export { LandingHeader };
