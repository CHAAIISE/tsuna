import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { cn } from "cn";
import { FleetConsole } from "@/components/fleet/fleet-console";
import { FleetSkeleton } from "@/components/fleet/fleet-skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";
import { isFleetId, type FleetId } from "@/lib/fleet/config";
import { readFleet } from "@/lib/fleet/read";

export const metadata: Metadata = {
  title: "Fleet — Leash",
  description: "Every Leash vault runs one factory-held executable: one timelocked patch upgrades them all.",
};

const fleets: { id: FleetId; label: string }[] = [
  { id: "demo", label: "Demo vaults" },
  { id: "test", label: "Test fleet" },
];

async function FleetLoader({ id }: { id: FleetId }) {
  const state = await readFleet(id).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fleet read failed");
    return "unreachable" as const;
  });
  if (state === "unreachable") {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6">
          <p className="font-medium">Stellar testnet did not answer.</p>
          <p className="text-sm text-muted-foreground">The fleet is read live from the ledger. Reload the page in a moment.</p>
        </CardContent>
      </Card>
    );
  }
  if (!state) {
    return <Card><CardContent className="pt-6 text-sm text-muted-foreground">This fleet is not deployed on testnet.</CardContent></Card>;
  }
  return <FleetConsole key={id} initial={state} />;
}

export default async function FleetPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requested = (await searchParams).fleet;
  const id: FleetId = isFleetId(requested) ? requested : "demo";
  return (
    <>
      <PageLayout>
        <PageHeader
          title="Fleet"
          description="One patch, every vault, one transaction."
          aside={(
            <nav aria-label="Fleets" className="flex gap-1 rounded-full bg-secondary p-1">
              {fleets.map(fleet => (
                <Link
                  key={fleet.id}
                  href={fleet.id === "demo" ? "/fleet" : `/fleet?fleet=${fleet.id}`}
                  aria-current={fleet.id === id ? "page" : undefined}
                  className={cn("rounded-full border border-transparent px-4 py-2 text-sm transition-colors hover:bg-muted", fleet.id === id && "border-input bg-card shadow-card")}
                >
                  {fleet.label}
                </Link>
              ))}
            </nav>
          )}
        />
        <Suspense key={id} fallback={<FleetSkeleton />}>
          <FleetLoader id={id} />
        </Suspense>
      </PageLayout>
    </>
  );
}
