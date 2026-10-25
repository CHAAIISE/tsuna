"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { usePasskeyAccount } from "@/lib/hooks/use-passkey-account";
import { useHoldings } from "@/lib/hooks/use-vault";

export function OnboardingProgress() {
  const pathname = usePathname();
  const { account, ready } = usePasskeyAccount();
  const holdings = useHoldings(pathname === "/onboarding" ? null : account?.account ?? null);
  if (pathname === "/onboarding") return null;

  const invested = holdings.data?.holdings.some(holding => BigInt(holding.shares) > 0n) ?? false;
  const funded = BigInt(holdings.data?.usdcBalance ?? "0") > 0n;
  const step = !account ? 0 : invested ? 3 : funded ? 2 : 1;
  const reading = !ready || (account !== null && holdings.isPending);

  return (
    <div className="mx-auto max-w-app space-y-2 px-4 pt-8 sm:px-6 lg:px-0">
      <OnboardingSteps currentStep={step} />
      <p className="px-1 text-caption text-muted-foreground" aria-live="polite">
        {reading ? "Reading your account progress from Stellar…" : holdings.error ? (
          <>Your balances could not be read. <button type="button" className="text-primary hover:underline" onClick={() => void holdings.refetch()}>Try again</button></>
        ) : !account ? (
          <>New here? <Link href="/onboarding" className="text-primary hover:underline">Create a passkey</Link> to try a deposit. No real funds needed.</>
        ) : invested ? "You hold vault shares. Open your vault to run its agent or try the attack lab." : funded ? (
          <>Your test USDC is ready. <Link href="/agents" className="text-primary hover:underline">Pick an agent</Link> and deposit.</>
        ) : (
          <>You need test USDC for a deposit. <Link href="/onboarding" className="text-primary hover:underline">Get test funds</Link>.</>
        )}
      </p>
    </div>
  );
}
