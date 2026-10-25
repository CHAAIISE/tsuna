"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentRunView } from "@/lib/stellar/types";
import { fetchJson } from "./fetch-json";
import { queryKeys } from "./keys";

/** Latest agent run of a vault started on this server, polled every 1.5 s while it runs. */
export function useAgentRun(id: string) {
  return useQuery({
    queryKey: queryKeys.run(id),
    queryFn: async () => (await fetchJson<{ run: AgentRunView | null }>(`/api/agent?vault=${encodeURIComponent(id)}`)).run,
    refetchInterval: query => query.state.data?.status === "running" ? 1_500 : false,
  });
}

/** Starts a run; when it ends, the vault and its activity are read again. */
export function useStartRun(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => (await fetchJson<{ run: AgentRunView }>("/api/agent", { vault: id })).run,
    onSuccess: run => client.setQueryData(queryKeys.run(id), run),
  });
}
