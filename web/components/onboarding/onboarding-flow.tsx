"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight, CircleAlert, ExternalLink, Fingerprint, Wallet } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { queryKeys } from "@/lib/hooks/keys";
import type { HoldingsResponse } from "@/lib/stellar/types";
import {
  createPasskeyAccount, forgetPasskeyAccount, parsePasskeyAccount, passkeyAccountSnapshot,
  readUsdcBalance, requestTestUsdc, subscribePasskeyAccount,
} from "@/lib/passkey/client";
import { EXPLORER_URL, formatUsdc, passkeyDeployment } from "@/lib/passkey/deployment";
import { passkeysSupported } from "@/lib/passkey/webauthn";
import { addUsdcTrustline, connectWallet } from "@/lib/wallet/kit";
import { TransactionDetails, type DetailRow } from "./transaction-details";

type Mode = "passkey" | "wallet";
type Pending = "create" | "connect" | "trustline" | "faucet";
interface Receipt {
  label: string;
  hash: string;
  testId?: string;
}

const WAITING = "Waiting for Stellar…";
const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
const errorMessage = (error: unknown) => {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "The passkey prompt was dismissed. Try again when you are ready.";
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
};

export function OnboardingFlow({ faucetAmount }: { faucetAmount: number }) {
  const client = useQueryClient();
  const storedAccount = useSyncExternalStore(subscribePasskeyAccount, passkeyAccountSnapshot, () => null);
  const account = parsePasskeyAccount(storedAccount);
  const supported = useSyncExternalStore(() => () => undefined, passkeysSupported, () => true);
  const [mode, setMode] = useState<Mode>("passkey");
  const [wallet, setWallet] = useState<string | null>(null);
  /** undefined: not read yet; null: classic account without a USDC trustline. */
  const [balance, setBalance] = useState<bigint | null | undefined>(undefined);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [notice, setNotice] = useState<Receipt | null>(null);

  const holder = mode === "passkey" ? account?.account ?? null : wallet;
  // A passkey account is ready once deployed; a wallet once it holds the USDC trustline.
  const ready = holder !== null && (mode === "passkey" || typeof balance === "bigint");
  const funded = typeof balance === "bigint" && balance > 0n;
  const step = !ready ? 0 : funded ? 2 : 1;
  const amountLabel = faucetAmount.toLocaleString("en-US");

  const refreshBalance = useCallback(async (address: string) => {
    const value = await readUsdcBalance(address);
    setBalance(value);
    client.setQueryData<HoldingsResponse>(queryKeys.holdings(address), current => current ? { ...current, usdcBalance: value?.toString() ?? null } : undefined);
  }, [client]);

  useEffect(() => {
    if (!holder) return;
    let cancelled = false;
    readUsdcBalance(holder)
      .then(value => { if (!cancelled) setBalance(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(errorMessage(reason)); });
    return () => { cancelled = true; };
  }, [holder]);

  const run = async (action: Pending, task: () => Promise<void>) => {
    setPending(action);
    setError(null);
    setNotice(null);
    try {
      await task();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(null);
    }
  };

  const record = (receipt: Receipt) => {
    setReceipts(current => [...current, receipt]);
    setNotice(receipt);
  };

  const createAccount = () => run("create", async () => {
    setBalance(undefined);
    const created = await createPasskeyAccount();
    if (created.deployHash) record({ label: "Smart account deployed", hash: created.deployHash, testId: "deploy-hash" });
    await refreshBalance(created.account);
  });

  const connect = () => run("connect", async () => {
    setBalance(undefined);
    const address = await connectWallet();
    setWallet(address);
    await refreshBalance(address);
  });

  const trust = () => run("trustline", async () => {
    if (!wallet) return;
    const { hash } = await addUsdcTrustline(wallet);
    record({ label: "USDC trustline added", hash });
    await refreshBalance(wallet);
  });

  const drip = () => run("faucet", async () => {
    if (!holder) return;
    const { hash } = await requestTestUsdc(holder);
    record({ label: "Test USDC received", hash, testId: "faucet-hash" });
    await refreshBalance(holder);
  });

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setBalance(undefined);
  };

  const details: DetailRow[] = [];
  if (holder) {
    details.push(mode === "passkey"
      ? { label: "Smart account", value: holder, kind: "contract", testId: "account-address" }
      : { label: "Wallet", value: holder, kind: "account", testId: "account-address" });
  }
  if (mode === "passkey" && account?.deployHash && !receipts.some(receipt => receipt.hash === account.deployHash)) {
    details.push({ label: "Smart account deployed", value: account.deployHash, kind: "tx" });
  }
  for (const { label, hash, testId } of receipts) details.push({ label, value: hash, kind: "tx", ...(testId && { testId }) });
  if (mode === "passkey") details.push({ label: "Passkey verifier", value: passkeyDeployment.verifier, kind: "contract" });
  details.push({ label: "Test USDC (Blend)", value: passkeyDeployment.usdc, kind: "contract" });

  return (
    <div className="space-y-6 sm:space-y-8">
      <OnboardingSteps currentStep={step} />
      <div className="grid items-start gap-6 sm:gap-8 lg:grid-cols-3">
        <Card className="lg:col-span-2" aria-live="polite">
          {!ready && mode === "passkey" && (
            <>
              <CardHeader>
                <p className="text-caption text-muted-foreground">Step 1</p>
                <CardTitle>Create your passkey</CardTitle>
                <CardDescription>Your device keeps the key. Use your fingerprint, face or PIN to approve actions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="flex gap-3"><Fingerprint aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />No seed phrase. Only your passkey can approve deposits and withdrawals.</p>
                <p className="flex gap-3"><ArrowRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />No gas. Leash pays the testnet network fees.</p>
                {!supported && <p className="text-muted-foreground">This browser cannot create passkeys. Use a wallet extension instead.</p>}
              </CardContent>
              <CardFooter className="flex-col items-stretch sm:flex-row sm:items-center">
                <Button data-primary data-testid="create-passkey" onClick={createAccount} pending={pending === "create"} disabled={!supported}>
                  {pending === "create" ? WAITING : "Create passkey"}
                </Button>
                <Button variant="outline" onClick={() => switchMode("wallet")} disabled={pending !== null}><Wallet aria-hidden="true" />Use a wallet extension</Button>
              </CardFooter>
            </>
          )}

          {!ready && mode === "wallet" && (
            <>
              <CardHeader>
                <p className="text-caption text-muted-foreground">Step 1</p>
                <CardTitle>{wallet ? "Add the USDC trustline" : "Connect a wallet"}</CardTitle>
                <CardDescription>
                  {wallet
                    ? "Classic Stellar accounts need a trustline before they can hold USDC. Leash opens it with the token contract's trust() call; you sign, the relayer pays the fee."
                    : "Use Freighter, xBull, Albedo or another Stellar wallet on testnet. The account must already exist on testnet."}
                </CardDescription>
              </CardHeader>
              {wallet && <CardContent className="text-sm">Connected as <span className="font-medium">{shortAddress(wallet)}</span></CardContent>}
              <CardFooter className="flex-col items-stretch sm:flex-row sm:items-center">
                {wallet ? (
                  <Button data-primary onClick={trust} pending={pending === "trustline"} disabled={balance === undefined}>
                    {pending === "trustline" ? WAITING : "Add USDC trustline"}
                  </Button>
                ) : (
                  <Button data-primary onClick={connect} pending={pending === "connect"}>
                    {pending === "connect" ? "Waiting for your wallet…" : "Connect a wallet"}
                  </Button>
                )}
                <Button variant="outline" onClick={() => { setWallet(null); switchMode("passkey"); }} disabled={pending !== null}><Fingerprint aria-hidden="true" />Use a passkey instead</Button>
              </CardFooter>
            </>
          )}

          {ready && (
            <>
              <CardHeader>
                <p className="text-caption text-muted-foreground">{funded ? "Up next" : "Step 2"}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success" data-testid="account-ready">{mode === "passkey" ? "Account ready" : "Wallet ready"}</Badge>
                  <span className="text-caption text-muted-foreground">{shortAddress(holder)}</span>
                </div>
                <CardTitle>{funded ? "You're funded" : "Get test USDC"}</CardTitle>
                <CardDescription>{funded ? "Next, pick an agent and deposit. Its leash is enforced by the vault contract." : `Testnet only: ${amountLabel} USDC to try Leash.`}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-caption text-muted-foreground">Balance, read on Stellar</p>
                <p className="text-section font-medium tabular-nums" data-testid="usdc-balance">{typeof balance === "bigint" ? formatUsdc(balance) : "—"} <span className="text-base font-normal text-muted-foreground">USDC</span></p>
              </CardContent>
              <CardFooter className="flex-col items-stretch sm:flex-row sm:items-center">
                {funded ? (
                  <Button asChild data-primary><Link href="/agents">Pick an agent <ArrowRight aria-hidden="true" /></Link></Button>
                ) : (
                  <Button data-primary data-testid="get-usdc" onClick={drip} pending={pending === "faucet"}>
                    {pending === "faucet" ? WAITING : `Get ${amountLabel} test USDC`}
                  </Button>
                )}
                {mode === "passkey" && (
                  <Button variant="ghost" onClick={() => { forgetPasskeyAccount(); switchMode("passkey"); }} disabled={pending !== null}>Forget this account</Button>
                )}
              </CardFooter>
            </>
          )}
        </Card>

        <aside className="space-y-4" aria-label="Status">
          {error && (
            <div role="alert" className="flex gap-3 rounded-xl border border-input bg-card p-4 text-sm shadow-card">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="space-y-1"><p className="font-medium">That didn&apos;t go through</p><p className="text-muted-foreground">{error}</p></div>
            </div>
          )}
          {notice && (
            <div role="status" className="space-y-1 rounded-xl border border-success/20 bg-success/10 p-4 text-sm">
              <p className="font-medium">{notice.label}</p>
              <a href={`${EXPLORER_URL}/tx/${notice.hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">View on Stellar Expert <ExternalLink aria-hidden="true" className="size-3" /></a>
            </div>
          )}
          <Card className="bg-muted shadow-none">
            <CardHeader className="space-y-3">
              <div className="flex items-center justify-between gap-2"><CardTitle className="text-base">How it works</CardTitle><Badge variant="secondary">Testnet only</Badge></div>
              <CardDescription>Test tokens have no value. Blend testnet USDC is borrowed against faucet XLM and sent from a Leash faucet account.</CardDescription>
            </CardHeader>
            <CardContent><TransactionDetails rows={details} /></CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
