import type { Metadata } from "next";
import { VaultView } from "@/components/vault/vault-view";
import { PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Agent vault — Leash",
  description: "Positions, rules and the agent's journal of a Leash vault, read on Stellar testnet.",
};

export default async function VaultPage({ params }: PageProps<"/agents/[id]">) {
  const { id } = await params;
  return (
    <>
      <PageLayout>
        <VaultView id={id} />
        <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
