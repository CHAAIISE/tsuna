import type { Metadata } from "next";
import { AttackLab } from "@/components/attack/attack-lab";
import { AccountAction } from "@/components/vault/account-action";
import { AppNavigation } from "@/components/ui/app-navigation";
import { PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Try to break it — Leash",
  description: "Five real attacks against testnet vaults. The chain decides, even with a stolen session key.",
};

export default async function AttackPage({ params }: PageProps<"/agents/[id]/attack">) {
  const { id } = await params;
  return <>
    <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
    <AppNavigation activePath="/agents" accountAction={<AccountAction />} />
    <PageLayout>
      <AttackLab id={id} />
      <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
    </PageLayout>
  </>;
}
