import type { Metadata } from "next";
import { PortfolioView } from "@/components/vault/portfolio-view";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Portfolio — Tsuna",
  description: "Your deposits in Tsuna vaults, their value and gains, read on Stellar.",
};

export default function PortfolioPage() {
  return (
    <>
      <PageLayout>
        <PageHeader title="Portfolio" description="Your deposits, read from the vaults. Withdrawals are always open." />
        <PortfolioView />
        <footer className="border-t py-6 text-caption text-muted-foreground">Tsuna · Built on Stellar</footer>
      </PageLayout>
    </>
  );
}
