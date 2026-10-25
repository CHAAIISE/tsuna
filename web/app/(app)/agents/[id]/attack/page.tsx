import type { Metadata } from "next";
import { AttackLab } from "@/components/attack/attack-lab";
import { PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Try to break it — Leash",
  description: "Five real attacks against testnet vaults. The chain decides, even with a stolen session key.",
};

export default async function AttackPage({ params }: PageProps<"/agents/[id]/attack">) {
  const { id } = await params;
  return (
    <PageLayout>
      <AttackLab id={id} />
      <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
    </PageLayout>
  );
}
