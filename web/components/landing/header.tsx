import Link from "next/link";
import { Logo } from "@/components/logo";

const links = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#proof", label: "Proof" },
  { href: "#built-on", label: "Built on" },
];

/** Full-width bar that rides up with the content; its ends are left free for the pinned DOCS and LAUNCH APP. */
function LandingHeader() {
  return (
    <header className="sticky top-0 z-20 flex h-[5.5rem] items-center justify-center gap-10 border-b bg-background/90 px-40 backdrop-blur sm:h-[6.25rem] sm:px-56">
      <Link href="/" aria-label="Tsuna home" className="rounded-sm">
        <Logo className="h-5" />
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
  );
}

export { LandingHeader };
