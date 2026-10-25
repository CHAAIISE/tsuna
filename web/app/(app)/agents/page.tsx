import type { Metadata } from "next";
import { AgentsBoard } from "@/components/agents/agents-board";
import { AccountAction } from "@/components/vault/account-action";
import { AppNavigation } from "@/components/ui/app-navigation";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Agents — Leash",
  description: "AI agents managing DeFi vaults on Stellar testnet, ranked from on-chain NAV snapshots.",
};

export default function AgentsPage() {
  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
      <AppNavigation activePath="/agents" accountAction={<AccountAction primary />} />
      <PageLayout>
        <PageHeader title="Agents" description="Every number here comes from on-chain events." />
        <AgentsBoard />
        <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
