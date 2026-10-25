import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { AppNavigation } from "@/components/ui/app-navigation";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Create your account — Leash",
  description: "A passkey on this device. No seed phrase, no gas.",
};

export default function OnboardingPage() {
  const faucetAmount = Number(process.env.LEASH_FAUCET_AMOUNT_USDC ?? "1000");
  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
      <AppNavigation activePath="/onboarding" accountAction={<Badge>Stellar testnet</Badge>} />
      <PageLayout>
        <PageHeader title="Create your account" description="A passkey on this device. No seed phrase, no gas." />
        <OnboardingFlow faucetAmount={faucetAmount} />
        <footer className="border-t py-6 text-caption text-muted-foreground">Leash · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
