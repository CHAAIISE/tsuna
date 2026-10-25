import type { Metadata } from "next";
import { AccountAction } from "@/components/vault/account-action";
import { VaultView } from "@/components/vault/vault-view";
import { AppNavigation } from "@/components/ui/app-navigation";
import { PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Agent vault — Leash",
  description: "Positions, rules and the agent's journal of a Leash vault, read on Stellar testnet.",
};

export default async function VaultPage({ params }: PageProps<"/agents/[id]">) {
  const { id } = await params;
  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
      <AppNavigation activePath="/agents" accountAction={<AccountAction />} />
      <PageLayout>
        <VaultView id={id} />
        <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
