"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { CircleAlert, ExternalLink, Fingerprint, LockKeyhole } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PasskeyAccount } from "@/lib/passkey/client";
import { VaultRefusal, useVaultAction } from "@/lib/hooks/use-vault-actions";
import { explorerTx, formatUsdc, parseUsdc, sharesFor, sharesValue } from "@/lib/stellar/format";
import type { HoldingView, TypedError, VaultDetail } from "@/lib/stellar/types";

type Mode = "deposit" | "withdraw";

const errorText = (error: unknown) => {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "The passkey prompt was dismissed. Try again when you are ready.";
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
};

/**
 * Deposit/Withdraw panel (Morpho layout): the passkey signs the vault call,
 * the Leash relayer submits it and pays the fee. Withdrawals stay open while
 * the vault is paused.
 */
export function DepositPanel({ vault, owner, holding, balance }: {
  vault: VaultDetail;
  owner: PasskeyAccount | null;
  holding: HoldingView | undefined;
  /** USDC balance in base units; null without a trustline, undefined while loading. */
  balance: string | null | undefined;
}) {
  // The panel renders after the vault loads (client only), so the URL hash is readable here.
  const [mode, setMode] = useState<Mode>(() => typeof window !== "undefined" && window.location.hash === "#withdraw" ? "withdraw" : "deposit");
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (["#deposit", "#withdraw"].includes(window.location.hash)) panel.current?.scrollIntoView({ block: "start" });
  }, []);
  const [text, setText] = useState("");
  const [receipt, setReceipt] = useState<{ mode: Mode; hash: string; amount: bigint } | null>(null);
  const inputId = useId();
  const action = useVaultAction({ id: vault.id, address: vault.address }, owner);
  const shares = BigInt(holding?.shares ?? "0");
  const position = vault.pps ? sharesValue(shares, vault.pps) : 0n;
  const available = mode === "deposit" ? (balance ? BigInt(balance) : 0n) : position;
  const amount = parseUsdc(text);
  const tooMuch = amount !== null && amount > available;
  const invalid = text.trim() !== "" && (amount === null || amount <= 0n || tooMuch);
  const blockedByPause = mode === "deposit" && vault.paused;
  const refusal: TypedError | null = action.error instanceof VaultRefusal ? action.error.error : null;

  const submit = () => {
    if (amount === null || amount <= 0n || !vault.pps) return;
    // A withdrawal is expressed in shares; "Max" sends every share so no dust is left.
    const value = mode === "deposit" ? amount : amount >= position ? shares : sharesFor(amount, vault.pps, shares);
    setReceipt(null);
    action.mutate({ action: mode, amount: value }, {
      onSuccess: ({ hash }) => {
        setReceipt({ mode, hash, amount });
        setText("");
      },
    });
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setText("");
    action.reset();
  };

  return (
    <Card ref={panel} id="deposit" className="scroll-mt-24 p-5" aria-label="Deposit and withdraw">
      <div role="tablist" aria-label="Action" className="grid grid-cols-2 gap-1 rounded-full bg-secondary p-1">
        {(["deposit", "withdraw"] as const).map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={mode === tab}
            onClick={() => switchMode(tab)}
            className={cn("rounded-full border border-transparent py-2 text-sm capitalize transition-colors", mode === tab ? "border-input bg-card shadow-card" : "text-muted-foreground hover:text-foreground")}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={inputId} className="text-sm font-medium">{mode === "deposit" ? "Deposit USDC" : "Withdraw USDC"}</label>
          {owner && (
            <button type="button" className="text-caption text-muted-foreground hover:text-primary" onClick={() => setText(formatUsdc(available, 7).replace(/,/g, ""))} disabled={available === 0n}>
              {mode === "deposit" ? "Balance" : "Position"} {balance === undefined && mode === "deposit" ? "…" : formatUsdc(available)} · Max
            </button>
          )}
        </div>
        <Input
          id={inputId}
          inputMode="decimal"
          placeholder="0.00"
          value={text}
          onChange={event => setText(event.target.value)}
          aria-invalid={invalid || undefined}
          disabled={!owner || action.isPending}
          data-testid={`${mode}-amount`}
        />
        {invalid && <p className="text-caption text-destructive">{tooMuch ? `You have ${formatUsdc(available)} USDC available.` : "Enter an amount greater than zero, up to 7 decimals."}</p>}
      </div>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Your position</dt><dd className="tabular-nums" data-testid="your-position">{owner ? `${formatUsdc(position)} USDC` : "—"}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Network fee</dt><dd>Paid by Leash (testnet)</dd></div>
        {mode === "withdraw" && <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Withdrawals</dt><dd>Always open, even when paused</dd></div>}
      </dl>

      <div className="mt-5">
        {!owner ? (
          <Button asChild data-primary className="w-full"><Link href="/onboarding"><Fingerprint aria-hidden="true" />Sign in with passkey</Link></Button>
        ) : (
          <Button
            className="w-full"
            onClick={submit}
            pending={action.isPending}
            disabled={amount === null || amount <= 0n || tooMuch || blockedByPause || !vault.sponsored || !vault.pps}
            data-testid={`${mode}-submit`}
            {...(mode === "deposit" ? { "data-primary": true } : {})}
          >
            {action.isPending ? "Waiting for Stellar…" : mode === "deposit" ? "Deposit" : "Withdraw"}
          </Button>
        )}
      </div>

      <div aria-live="polite" className="mt-4 space-y-3 text-sm">
        {blockedByPause && (
          <p className="rounded-lg border-l-[3px] border-destructive bg-destructive-soft px-3 py-2">The vault is paused: deposits are closed. Withdrawals stay open.</p>
        )}
        {!vault.sponsored && <p className="text-muted-foreground">The Leash relayer only sponsors calls to listed vaults; this one is not listed.</p>}
        {owner && mode === "deposit" && (balance === null || balance === "0") && <p className="text-muted-foreground">This account has no USDC yet. <Link href="/onboarding" className="text-primary hover:underline">Get test USDC</Link></p>}
        {refusal && (
          <div role="alert" className="space-y-1 rounded-lg border-l-[3px] border-destructive bg-destructive-soft px-3 py-2">
            <p className="flex items-center gap-2 font-medium text-destructive"><LockKeyhole aria-hidden="true" className="size-4" />{refusal.name}</p>
            <p>The chain refused: {refusal.message}</p>
          </div>
        )}
        {action.error && !refusal && (
          <p role="alert" className="flex gap-2 rounded-lg border border-input bg-card px-3 py-2"><CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />{errorText(action.error)}</p>
        )}
        {receipt && (
          <div role="status" data-testid="action-receipt" className="space-y-1 rounded-lg border border-success/20 bg-success/10 px-3 py-2">
            <p className="font-medium">{receipt.mode === "deposit" ? `Deposited ${formatUsdc(receipt.amount)} USDC` : `Withdrew ${formatUsdc(receipt.amount)} USDC`}</p>
            <a href={explorerTx(receipt.hash)} target="_blank" rel="noreferrer" data-testid="action-hash" data-hash={receipt.hash} className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">View on Stellar Expert <ExternalLink aria-hidden="true" className="size-3" /></a>
          </div>
        )}
      </div>
    </Card>
  );
}
