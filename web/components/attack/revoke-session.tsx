"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchJson } from "@/lib/hooks/fetch-json";
import { queryKeys } from "@/lib/hooks/keys";
import { connectWallet, signCreatorTransaction } from "@/lib/wallet/kit";
import type { VaultDetail } from "@/lib/stellar/types";

export function RevokeSession({ vault, disabled }: { vault: VaultDetail; disabled: boolean }) {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const revoke = async () => {
    setError(null);
    setPending(true);
    try {
      const account = await connectWallet();
      if (account !== vault.owner) throw new Error("Connect the wallet that created this vault. A depositor cannot revoke its agent.");
      const prepared = await fetchJson<{ xdr: string }>("/api/attack", { action: "prepare-revoke", vault: vault.id, account });
      const receipt = await signCreatorTransaction(account, prepared.xdr);
      setHash(receipt.hash);
      const detail = await fetchJson<VaultDetail>(`/api/vaults/${encodeURIComponent(vault.id)}?fresh=1`);
      client.setQueryData(queryKeys.vault(vault.id), detail);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Revocation failed. Try again with the creator's wallet.");
    } finally { setPending(false); }
  };
  return <Card data-testid="session-control">
    <CardHeader><CardTitle>Cut off a stolen key</CardTitle><CardDescription>The creator of {vault.name} can revoke its default session immediately. Withdrawals and separately authorized risk-off roles stay open.</CardDescription></CardHeader>
    <div className="space-y-3 px-6 pb-6">
      <p className="text-sm" data-testid="session-state">{vault.session ? "Default session is active." : "Default session is revoked."}</p>
      <Button variant="outline" pending={pending} disabled={disabled || !vault.session} onClick={() => void revoke()}>{pending ? "Confirm in creator wallet…" : "Revoke session key"}</Button>
      <p className="text-caption text-muted-foreground">Requires the creator&apos;s wallet signature, not the depositor&apos;s passkey. This stops later attacks and agent runs until the creator rotates the session.</p>
      {error && <p role="alert" className="text-sm text-muted-foreground">{error}</p>}
      {hash && <p role="status" className="text-sm text-destructive">Session revoked. <a href={`https://stellar.expert/explorer/testnet/tx/${hash}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">View transaction</a></p>}
    </div>
  </Card>;
}
