"use client";

import Link from "next/link";
import { ArrowRight, CircleAlert, Fingerprint } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePasskeyAccount } from "@/lib/hooks/use-passkey-account";
import { useHoldings } from "@/lib/hooks/use-vault";
import { explorerAccount, formatAge, formatSharePrice, formatUsdc, shortAddress } from "@/lib/stellar/format";
import type { HoldingView } from "@/lib/stellar/types";

function Gain({ units }: { units: bigint }) {
  const tone = units > 0n ? "text-success" : units < 0n ? "text-loss" : "text-foreground";
  const abs = units < 0n ? -units : units;
  // Interest on a fresh deposit is a few base units: keep them visible instead of rounding to zero.
  const digits = abs === 0n ? 2 : abs < 1_000n ? 7 : abs < 100_000n ? 4 : 2;
  return <span className={`tabular-nums ${tone}`}>{units > 0n ? "+" : ""}{formatUsdc(units, digits)} USDC</span>;
}

function Kpi({ label, children, hint, testId }: { label: string; children: React.ReactNode; hint: string; testId?: string }) {
  return (
    <Card className="p-5">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 text-section font-medium tabular-nums" data-testid={testId}>{children}</p>
      <p className="mt-1 text-caption text-muted-foreground">{hint}</p>
    </Card>
  );
}

const gainOf = (holding: HoldingView) => BigInt(holding.value) - BigInt(holding.netDeposited);

/** The signed-in user's deposits: value now, net deposits seen on-chain, gains, withdraw shortcut. */
export function PortfolioView() {
  const { account, ready } = usePasskeyAccount();
  const holdings = useHoldings(account?.account ?? null);

  if (!ready) return <div role="status" aria-label="Loading" className="h-40 animate-pulse rounded-xl bg-secondary" />;
  if (!account) {
    return (
      <Card className="flex flex-col items-start gap-4 p-4 sm:p-6">
        <p className="text-subheading font-medium">Sign in to see your deposits</p>
        <p className="max-w-xl text-sm text-muted-foreground">Your passkey account lives on this device. Tsuna reads its vault shares and USDC balance straight from Stellar testnet.</p>
        <Button asChild data-primary><Link href="/onboarding"><Fingerprint aria-hidden="true" />Sign in with passkey</Link></Button>
      </Card>
    );
  }

  const data = holdings.data;
  const list = data?.holdings ?? [];
  const value = list.reduce((sum, holding) => sum + BigInt(holding.value), 0n);
  const deposited = list.reduce((sum, holding) => sum + BigInt(holding.netDeposited), 0n);
  const firstSeen = list.reduce<number | null>((min, holding) => holding.firstSeen !== null && (min === null || holding.firstSeen < min) ? holding.firstSeen : min, null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Passkey account <a href={explorerAccount(account.account)} target="_blank" rel="noreferrer" title={account.account} className="font-medium text-foreground hover:text-primary" data-testid="portfolio-account">{shortAddress(account.account)}</a>
        </p>
        <Button asChild data-primary><Link href="/agents">Explore agents <ArrowRight aria-hidden="true" /></Link></Button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Value in vaults" hint="Your shares at each vault's price per share" testId="portfolio-value">{data ? `${formatUsdc(value)} USDC` : "—"}</Kpi>
        <Kpi label="Net deposited" hint="Deposits minus withdrawals in retained events">{data ? `${formatUsdc(deposited)} USDC` : "—"}</Kpi>
        <Kpi label="Gains" hint={firstSeen ? `Since your first deposit seen (${formatAge(firstSeen)})` : "No deposit yet"}>{data ? <Gain units={value - deposited} /> : "—"}</Kpi>
        <Kpi label="Wallet" hint="USDC on your passkey account" testId="portfolio-wallet">{data ? data.usdcBalance === null ? "No USDC yet" : `${formatUsdc(data.usdcBalance)} USDC` : "—"}</Kpi>
      </div>

      <Card className="overflow-hidden">
        <h2 className="px-6 pt-6 pb-2 text-subheading font-medium">Your deposits</h2>
        {holdings.isPending && <div role="status" className="px-6 py-8 text-sm text-muted-foreground">Reading your vault shares on Stellar…</div>}
        {holdings.error && !data && (
          <div role="alert" className="flex flex-col items-start gap-3 px-6 py-8">
            <p className="flex items-center gap-2 font-medium"><CircleAlert aria-hidden="true" className="size-4 text-muted-foreground" />Stellar testnet did not answer</p>
            <Button variant="outline" onClick={() => void holdings.refetch()}>Try again</Button>
          </div>
        )}
        {data && list.length === 0 && (
          <div className="space-y-2 px-6 pt-2 pb-8">
            <p className="text-sm text-muted-foreground">No deposit yet. Pick an agent, read its rules, then deposit.</p>
          </div>
        )}
        {list.length > 0 && (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-table" data-testid="holdings">
                <thead className="border-y text-caption text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-3 pr-3 pl-6 font-normal">Agent</th>
                    <th scope="col" className="px-3 py-3 font-normal">Value</th>
                    <th scope="col" className="px-3 py-3 font-normal">Net deposited</th>
                    <th scope="col" className="px-3 py-3 font-normal">Gain</th>
                    <th scope="col" className="px-3 py-3 font-normal">NAV / share</th>
                    <th scope="col" className="py-3 pr-6 pl-3 font-normal"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(holding => (
                    <tr key={holding.vault} data-testid="holding-row" data-vault={holding.vault} className="h-table-row border-b last:border-0">
                      <td className="py-3 pr-3 pl-6">
                        <Link href={`/agents/${holding.id}`} className="font-medium hover:text-primary">{holding.name}</Link>
                        {holding.paused && <span className="ml-2 rounded-full bg-destructive-soft px-2 py-0.5 text-caption text-destructive">Paused</span>}
                      </td>
                      <td className="px-3 py-3 tabular-nums" data-testid="holding-value">{formatUsdc(holding.value)} USDC</td>
                      <td className="px-3 py-3 tabular-nums">{formatUsdc(holding.netDeposited)} USDC</td>
                      <td className="px-3 py-3"><Gain units={gainOf(holding)} /></td>
                      <td className="px-3 py-3 tabular-nums text-muted-foreground">{holding.pps ? formatSharePrice(holding.pps) : "—"}</td>
                      <td className="py-3 pr-6 pl-3 text-right">
                        {BigInt(holding.shares) > 0n && <Button asChild variant="outline" size="sm"><Link href={`/agents/${holding.id}#withdraw`} data-testid="withdraw-shortcut">Withdraw</Link></Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y border-t md:hidden">
              {list.map(holding => (
                <li key={holding.vault} data-testid="holding-card" className="space-y-2 px-4 py-4">
                  <p className="flex items-center justify-between gap-2">
                    <Link href={`/agents/${holding.id}`} className="font-medium hover:text-primary">{holding.name}</Link>
                    <span className="tabular-nums">{formatUsdc(holding.value)} USDC</span>
                  </p>
                  <p className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
                    <span>Deposited {formatUsdc(holding.netDeposited)} · Gain <Gain units={gainOf(holding)} /></span>
                    {BigInt(holding.shares) > 0n && <Link href={`/agents/${holding.id}#withdraw`} className="text-primary">Withdraw</Link>}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="border-t px-6 py-3 text-caption text-muted-foreground">Value: shares × price per share, read on-chain. Net deposited comes from the vault&apos;s Deposited/Withdrawn events the RPC still retains (about 7 days).</p>
      </Card>
    </div>
  );
}
