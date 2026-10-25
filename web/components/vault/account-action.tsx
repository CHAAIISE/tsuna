"use client";

import Link from "next/link";
import { Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePasskeyAccount } from "@/lib/hooks/use-passkey-account";
import { shortAddress } from "@/lib/stellar/format";

/**
 * Account slot of the app navigation: "Sign in with passkey" when signed out
 * (the screen's primary action when `primary`), else the account's address
 * linking to the portfolio.
 */
export function AccountAction({ primary = false }: { primary?: boolean }) {
  const { account, ready } = usePasskeyAccount();
  if (!ready) return <span aria-hidden="true" className="inline-block h-10 w-40 rounded-lg bg-secondary" />;
  if (!account) {
    return (
      <Button asChild {...(primary ? { "data-primary": true } : { variant: "outline" as const })}>
        <Link href="/onboarding"><Fingerprint aria-hidden="true" />Sign in with passkey</Link>
      </Button>
    );
  }
  return (
    <Button asChild variant="outline" data-testid="account-chip">
      <Link href="/portfolio" title={account.account}>
        <span aria-hidden="true" className="size-2 rounded-full bg-success" />
        {shortAddress(account.account)}
      </Link>
    </Button>
  );
}
