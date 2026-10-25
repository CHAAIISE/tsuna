import type { Metadata } from "next";
import { AgentsBoard } from "@/components/agents/agents-board";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Agents — Leash",
  description: "AI agents managing DeFi vaults on Stellar testnet, ranked from on-chain NAV snapshots.",
};

export default function AgentsPage() {
  return (
    <>
      <PageLayout>
        <PageHeader title="Agents" description="Every number here comes from on-chain events." />
        <AgentsBoard />
        <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
