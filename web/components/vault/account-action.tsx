"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Copy, Droplets, Fingerprint, LogOut, UserRound } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/hooks/keys";
import { usePasskeyAccount } from "@/lib/hooks/use-passkey-account";
import { useHoldings } from "@/lib/hooks/use-vault";
import { forgetPasskeyAccount, requestTestUsdc } from "@/lib/passkey/client";
import { EXPLORER_URL, formatUsdc } from "@/lib/passkey/deployment";
import { shortAddress } from "@/lib/stellar/format";

/**
 * Account slot of the app navigation: "Sign in with passkey" when signed out
 * (the screen's primary action when `primary`), else an account icon
 * opening a menu with its balance, the faucet, the address and sign out.
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
  return <AccountMenu address={account.account} />;
}

function AccountMenu({ address }: { address: string }) {
  const queryClient = useQueryClient();
  const holdings = useHoldings(address);
  const [copied, setCopied] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [faucet, setFaucet] = useState<{ state: "idle" | "pending" } | { state: "done"; hash: string; amount: bigint } | { state: "error"; message: string }>({ state: "idle" });

  const balance = holdings.data?.usdcBalance;

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const drip = async () => {
    setFaucet({ state: "pending" });
    try {
      const { hash, amount } = await requestTestUsdc(address);
      setFaucet({ state: "done", hash, amount });
      await queryClient.invalidateQueries({ queryKey: queryKeys.holdings(address) });
    } catch (error) {
      setFaucet({ state: "error", message: error instanceof Error ? error.message : "The faucet did not answer." });
    }
  };

  return (
    <Popover.Root onOpenChange={open => { if (!open) setConfirmSignOut(false); }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="account-chip"
          aria-label={`Account ${shortAddress(address)}`}
          title={address}
          className="flex size-10 items-center justify-center rounded-full border border-primary/40 bg-card text-primary shadow-card transition-colors hover:bg-primary hover:text-primary-foreground data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
        >
          <UserRound aria-hidden="true" className="size-5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-primary/25 bg-card p-5 text-card-foreground shadow-2xl"
        >
          <p className="font-display text-xs tracking-[0.18em] text-primary uppercase">Passkey account</p>

          <div className="mt-4">
            <p className="text-caption text-muted-foreground">Balance</p>
            <p className="mt-1 font-editorial text-3xl font-medium text-heading tabular-nums" data-testid="account-balance">
              {holdings.isPending ? "…" : typeof balance === "string" ? formatUsdc(BigInt(balance)) : "—"}
              <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">USDC</span>
            </p>
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={address}>{address}</span>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={copied ? "Address copied" : "Copy address"}
              className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-primary"
            >
              {copied ? <Check aria-hidden="true" className="size-4 text-success" /> : <Copy aria-hidden="true" className="size-4" />}
            </button>
            <a
              href={`${EXPLORER_URL}/contract/${address}`}
              target="_blank"
              rel="noreferrer"
              aria-label="Open the account on the explorer"
              className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors hover:text-primary"
            >
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </a>
          </div>

          <Button className="mt-4 w-full" onClick={() => void drip()} pending={faucet.state === "pending"} data-testid="account-faucet">
            <Droplets aria-hidden="true" />Get test USDC
          </Button>
          <p role="status" className="mt-2 min-h-5 text-caption text-muted-foreground">
            {faucet.state === "done" && (
              <>
                {formatUsdc(faucet.amount)} USDC received.{" "}
                <a href={`${EXPLORER_URL}/tx/${faucet.hash}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">View transaction</a>
              </>
            )}
            {faucet.state === "error" && <span className="text-destructive">{faucet.message}</span>}
          </p>

          <div className="mt-2 flex items-center justify-between gap-3 border-t pt-4">
            <Popover.Close asChild>
              <Link href="/portfolio" className="text-sm text-muted-foreground transition-colors hover:text-heading">Portfolio</Link>
            </Popover.Close>
            {confirmSignOut ? (
              <button type="button" onClick={forgetPasskeyAccount} className="inline-flex items-center gap-1.5 text-sm font-medium text-destructive hover:underline">
                <LogOut aria-hidden="true" className="size-4" />Confirm sign out
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmSignOut(true)} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-destructive">
                <LogOut aria-hidden="true" className="size-4" />Sign out
              </button>
            )}
          </div>
          {confirmSignOut && (
            <p className="mt-3 text-caption text-muted-foreground">
              This browser forgets the account, and Tsuna cannot reopen it afterwards. Withdraw your deposits first: the funds stay on-chain either way.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
