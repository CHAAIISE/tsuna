"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchJson } from "@/lib/hooks/fetch-json";
import type { ProtocolWatch as Watch } from "@/lib/stellar/attack-types";

export function ProtocolWatch({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ["protocol-watch", id],
    queryFn: () => fetchJson<{ protocols: Watch[]; asOf: string }>(`/api/attack?watch=${encodeURIComponent(id)}`),
    refetchInterval: 30_000,
  });
  return <Card data-testid="protocol-watch">
    <CardHeader><CardTitle>Protocol upgrade watch</CardTitle><CardDescription>Pinned on-chain code compared with each protocol&apos;s current executable. Changed code is refused until the creator revalidates it.</CardDescription></CardHeader>
    <div className="space-y-3 px-6 pb-6">
      {query.isPending && <p role="status" className="text-sm text-muted-foreground">Reading protocol code from Stellar…</p>}
      {query.error && <div role="alert" className="space-y-2 text-sm text-muted-foreground"><p>Monitoring state could not be read. This build may not support the watch.</p><Button variant="outline" onClick={() => void query.refetch()}>Read again</Button></div>}
      {query.data?.protocols.map(protocol => {
        const changed = protocol.halted || (protocol.pinned !== null && protocol.current !== protocol.pinned);
        return <div key={protocol.protocol} className="space-y-2 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{protocol.name}</span><span className={changed ? "text-destructive" : "text-muted-foreground"}>{changed ? "Code changed — review required" : protocol.current === null ? "No Wasm executable reported" : protocol.pinned ? "Pinned code matches" : "Not pinned yet"}</span></div>
          <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">Details</summary><dl className="mt-2 space-y-2 break-all font-mono"><dt>Contract</dt><dd>{protocol.protocol}</dd><dt>Pinned executable</dt><dd>{protocol.pinned ?? "None"}</dd><dt>Current executable</dt><dd>{protocol.current ?? "No Wasm hash"}</dd></dl></details>
        </div>;
      })}
      {query.data?.protocols.length === 0 && <p className="text-sm text-muted-foreground">No protocols are allowlisted. Add a protocol policy before running this agent.</p>}
      {query.data && <p className="text-caption text-muted-foreground">Read at {new Date(query.data.asOf).toLocaleTimeString("en-US")}. Refreshes every 30 seconds.</p>}
    </div>
  </Card>;
}
