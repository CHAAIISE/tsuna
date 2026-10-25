"use client";

import { useQuery } from "@tanstack/react-query";
import type { ActivityResponse, HoldingsResponse, VaultDetail } from "@/lib/stellar/types";
import { fetchJson } from "./fetch-json";
import { queryKeys } from "./keys";

/** NAV, positions, policy, roles and budgets of one vault. */
export function useVault(id: string) {
  return useQuery({
    queryKey: queryKeys.vault(id),
    queryFn: () => fetchJson<VaultDetail>(`/api/vaults/${encodeURIComponent(id)}`),
    refetchInterval: 30_000,
  });
}

/** Agent journal and on-chain activity of a vault; polled faster while the agent runs. */
export function useActivity(id: string, { live = false }: { live?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.activity(id),
    queryFn: () => fetchJson<ActivityResponse>(`/api/vaults/${encodeURIComponent(id)}/activity`),
    refetchInterval: live ? 5_000 : 30_000,
  });
}

/** Shares and value of `user` in every vault, and their USDC balance. */
export function useHoldings(user: string | null) {
  return useQuery({
    queryKey: queryKeys.holdings(user ?? ""),
    queryFn: () => fetchJson<HoldingsResponse>(`/api/vaults/holdings?user=${encodeURIComponent(user ?? "")}`),
    enabled: user !== null,
    refetchInterval: 30_000,
  });
}
