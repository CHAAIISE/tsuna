import type { Metadata } from "next";
import { PortfolioView } from "@/components/vault/portfolio-view";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Portfolio — Leash",
  description: "Your deposits in Leash vaults, their value and gains, read on Stellar testnet.",
};

export default function PortfolioPage() {
  return (
    <>
      <PageLayout>
        <PageHeader title="Portfolio" description="Your deposits, read from the vaults. Withdrawals are always open." />
        <PortfolioView />
        <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
