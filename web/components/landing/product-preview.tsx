import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SectionIntro } from "./section";

export function ProductPreview() {
  return (
    <section id="product" aria-labelledby="product-title" className="scroll-mt-0 border-t px-6 py-16 sm:px-12 sm:py-24">
      <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-end">
        <SectionIntro
          id="product-title"
          overline="Inside the vault"
          title="See where the USDC is held."
          lead="Positions, exposure limits and every decision in one place. Read the vault before you deposit."
        />
        <Link href="/agents/prudent" className="inline-flex shrink-0 items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline">
          Open Agent Prudent <ArrowUpRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
      <figure className="mt-10 overflow-hidden rounded-xl border bg-card shadow-editorial">
        <div className="border-b bg-muted px-4 py-3 text-caption text-muted-foreground sm:px-6">
          Agent Prudent · Stellar testnet
        </div>
        <picture>
          <source media="(max-width: 639px)" srcSet="/product/prudent-mobile.jpg" width={390} height={1400} />
          <Image
            src="/product/prudent-desktop.jpg"
            width={1260}
            height={800}
            unoptimized
            alt="Prudent vault showing its on-chain share value, positions in Blend and DeFindex, and deposit panel."
            className="h-auto w-full"
          />
        </picture>
        <figcaption className="border-t bg-muted px-4 py-3 text-caption text-muted-foreground sm:px-6">
          A testnet snapshot, not a live quote. Open the vault for current balances and rules.
        </figcaption>
      </figure>
    </section>
  );
}
