"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/hooks/fetch-json";
import { queryKeys } from "@/lib/hooks/keys";
import type { CrashResponse, CrashRunView, CrashStepId } from "@/lib/crash/types";
import type { ActivityResponse, VaultDetail } from "@/lib/stellar/types";

const crashKey = (vault: string) => ["crash", vault] as const;

/**
 * Crash demo state of `vault`: live readings every few seconds, every 1.5 s while a step runs.
 * When a step lands, the vault and its activity are read again past the server caches.
 */
export function useCrash(vault: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: crashKey(vault),
    queryFn: () => fetchJson<CrashResponse>(`/api/crash?vault=${encodeURIComponent(vault)}`),
    refetchInterval: q => !q.state.data?.vault ? false : q.state.data.run?.busy ? 1_500 : 5_000,
  });

  const busy = query.data?.run?.busy ?? null;
  const last = useRef(busy);
  useEffect(() => {
    if (last.current && !busy) {
      void Promise.all([
        fetchJson<VaultDetail>(`/api/vaults/${encodeURIComponent(vault)}?fresh=1`).then(data => client.setQueryData(queryKeys.vault(vault), data)),
        fetchJson<ActivityResponse>(`/api/vaults/${encodeURIComponent(vault)}/activity?fresh=1`).then(data => client.setQueryData(queryKeys.activity(vault), data)),
      ]).catch(() => undefined);
    }
    last.current = busy;
  }, [busy, vault, client]);
  return query;
}

/** Starts `step` on the server; the outcome arrives through {@link useCrash}. */
export function useCrashStep(vault: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (step: CrashStepId) => (await fetchJson<{ run: CrashRunView }>("/api/crash", { step })).run,
    onSuccess: run => client.setQueryData<CrashResponse>(crashKey(vault), data => (data ? { ...data, run } : data)),
  });
}
