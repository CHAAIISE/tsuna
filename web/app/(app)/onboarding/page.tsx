import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

export const metadata: Metadata = {
  title: "Create your account — Tsuna",
  description: "A passkey on this device. No seed phrase, no gas.",
};

export default function OnboardingPage() {
  const faucetAmount = Number(process.env.LEASH_FAUCET_AMOUNT_USDC ?? "1000");
  return (
    <>
      <PageLayout>
        <PageHeader title="Create your account" description="A passkey on this device. No seed phrase, no gas." />
        <OnboardingFlow faucetAmount={faucetAmount} />
        <footer className="border-t py-6 text-caption text-muted-foreground">Tsuna · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
