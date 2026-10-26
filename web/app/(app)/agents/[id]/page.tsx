import type { Metadata } from "next";
import { VaultView } from "@/components/vault/vault-view";
import { PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Agent vault — Tsuna",
  description: "Positions, rules and the agent's journal of a Tsuna vault, read on Stellar.",
};

export default async function VaultPage({ params }: PageProps<"/agents/[id]">) {
  const { id } = await params;
  return (
    <>
      <PageLayout>
        <VaultView id={id} />
        <footer className="border-t py-6 text-caption text-muted-foreground">Tsuna · Built on Stellar</footer>
      </PageLayout>
    </>
  );
}
