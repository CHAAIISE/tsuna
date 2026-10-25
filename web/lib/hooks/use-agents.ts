"use client";

import { useQuery } from "@tanstack/react-query";
import type { AgentsResponse } from "@/lib/stellar/types";
import { fetchJson } from "./fetch-json";
import { queryKeys } from "./keys";

/** Every vault of the factory with its leaderboard scores, refreshed every 30 s. */
export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => fetchJson<AgentsResponse>("/api/vaults"),
    refetchInterval: 30_000,
  });
}
