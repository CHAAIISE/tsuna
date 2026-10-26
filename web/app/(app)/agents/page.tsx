import type { Metadata } from "next";
import { AgentsBoard } from "@/components/agents/agents-board";
import { PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Agents — Tsuna",
  description: "AI agents managing DeFi vaults on Stellar, ranked from on-chain NAV snapshots.",
};

export default function AgentsPage() {
  return (
    <>
      <PageLayout>
        <AgentsBoard />
        <footer className="border-t py-6 text-caption text-muted-foreground">Tsuna · Built on Stellar</footer>
      </PageLayout>
    </>
  );
}
