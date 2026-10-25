import { Card } from "@/components/ui/card";

/** Placeholder rows while the fleet is read from the ledger. */
export function FleetSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Reading the fleet from Stellar testnet">
      <Card className="grid gap-6 p-6 sm:grid-cols-3">
        {[0, 1, 2].map(cell => (
          <div key={cell} className="space-y-2">
            <div className="h-3 w-24 animate-pulse rounded bg-secondary" />
            <div className="h-5 w-40 animate-pulse rounded bg-secondary" />
          </div>
        ))}
      </Card>
      <Card className="overflow-hidden">
        <div className="h-16 border-b" />
        {[0, 1, 2].map(row => (
          <div key={row} className="flex h-table-row items-center gap-6 border-b px-6 last:border-b-0">
            <div className="h-4 w-32 animate-pulse rounded bg-secondary" />
            <div className="h-4 w-24 animate-pulse rounded bg-secondary" />
            <div className="h-4 w-36 animate-pulse rounded bg-secondary" />
          </div>
        ))}
      </Card>
    </div>
  );
}
