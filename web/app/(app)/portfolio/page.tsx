import type { Metadata } from "next";
import { AccountAction } from "@/components/vault/account-action";
import { PortfolioView } from "@/components/vault/portfolio-view";
import { AppNavigation } from "@/components/ui/app-navigation";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Portfolio — Leash",
  description: "Your deposits in Leash vaults, their value and gains, read on Stellar testnet.",
};

export default function PortfolioPage() {
  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
      <AppNavigation activePath="/portfolio" accountAction={<AccountAction />} />
      <PageLayout>
        <PageHeader title="Portfolio" description="Your deposits, read from the vaults. Withdrawals are always open." />
        <PortfolioView />
        <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
