import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import Link from "next/link";

export default function Home() {
  return (
    <div className="mx-auto min-h-screen max-w-site border-x px-6 sm:px-12">
      <header className="flex items-center justify-between border-b py-6">
        <Link href="/" aria-label="Leash home"><Logo /></Link>
        <span className="rounded-full border px-3 py-1 text-sm text-muted-foreground">
          Stellar testnet
        </span>
      </header>
      <main>
        <section className="max-w-3xl py-16 sm:py-24">
          <p className="mb-6 text-sm text-muted-foreground">DeFi vaults on Stellar</p>
          <h1 className="text-4xl font-light tracking-tight text-heading sm:text-hero">
            Agents propose trades.
            <br />
            <span className="text-muted-foreground">The chain holds the leash.</span>
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground">
            A vault checks which contracts an agent can call, where funds can go,
            and whether the call preserves their value.
          </p>
          <Button asChild size="lg" className="mt-8 h-12 px-6" data-primary>
            <a href="#how-it-works">How the leash works</a>
          </Button>
        </section>
        <section id="how-it-works" className="border-t py-12 sm:py-16">
          <h2 className="text-2xl font-medium">A proposal is not permission.</h2>
          <ol className="mt-8 grid gap-8 sm:grid-cols-3">
            <li>
              <p className="mb-3 text-sm text-muted-foreground">01 / Propose</p>
              <h3 className="font-medium">The agent chooses a call</h3>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                Its session key can request an action, not bypass the vault.
              </p>
            </li>
            <li>
              <p className="mb-3 text-sm text-muted-foreground">02 / Check</p>
              <h3 className="font-medium">The vault checks the rules</h3>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                Contract, function and destination must match the allowlist.
              </p>
            </li>
            <li>
              <p className="mb-3 text-sm text-muted-foreground">03 / Enforce</p>
              <h3 className="font-medium">The chain has the final say</h3>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                If the call breaks the value limit, the transaction rolls back.
              </p>
            </li>
          </ol>
        </section>
      </main>
      <footer className="border-t py-6 text-sm text-muted-foreground">
        Testnet only. No real funds.
      </footer>
    </div>
  );
}
