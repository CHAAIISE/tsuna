"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { invokeWithPasskey, type PasskeyAccount } from "@/lib/passkey/client";
import type { ActivityResponse, HoldingsResponse, TypedError, VaultDetail } from "@/lib/stellar/types";
import { fetchJson } from "./fetch-json";
import { queryKeys } from "./keys";

/** The vault refused the call in simulation: carries its typed error. */
export class VaultRefusal extends Error {
  constructor(readonly error: TypedError) {
    super(`The chain refused: ${error.message}`);
  }
}

export interface VaultActionInput {
  action: "deposit" | "withdraw";
  /** Base units for a deposit, raw shares for a withdrawal. */
  amount: bigint;
}

/**
 * Deposits into or withdraws from a vault with the passkey account: the vault
 * call is simulated first (a refusal shows its typed error), then the passkey
 * signs and the Leash relayer submits and pays the fee. Afterwards the user's
 * holdings, the vault and its activity are read again, bypassing server caches.
 */
export function useVaultAction(vault: { id: string; address: string }, owner: PasskeyAccount | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, amount }: VaultActionInput) => {
      if (!owner) throw new Error("Sign in with a passkey first.");
      const check = await fetchJson<{ ok: boolean; error: TypedError | null }>(
        `/api/vaults/${encodeURIComponent(vault.id)}/preflight`, { action, user: owner.account, amount: amount.toString() },
      );
      if (!check.ok && check.error) throw new VaultRefusal(check.error);
      return invokeWithPasskey(owner, {
        contract: vault.address,
        method: action,
        args: [new Address(owner.account).toScVal(), nativeToScVal(amount, { type: "i128" })],
      });
    },
    onSuccess: async () => {
      if (!owner) return;
      const id = encodeURIComponent(vault.id);
      const [holdings, detail, activity] = await Promise.all([
        fetchJson<HoldingsResponse>(`/api/vaults/holdings?user=${encodeURIComponent(owner.account)}&fresh=1`),
        fetchJson<VaultDetail>(`/api/vaults/${id}?fresh=1`),
        fetchJson<ActivityResponse>(`/api/vaults/${id}/activity?fresh=1`),
      ]);
      client.setQueryData(queryKeys.holdings(owner.account), holdings);
      client.setQueryData(queryKeys.vault(vault.id), detail);
      client.setQueryData(queryKeys.activity(vault.id), activity);
      await client.invalidateQueries({ queryKey: queryKeys.agents });
    },
  });
}
