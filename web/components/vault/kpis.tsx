import { Card } from "@/components/ui/card";
import { ReturnValue } from "@/components/agents/metric";
import { formatAge, formatHealth, formatSharePrice, formatUsdc } from "@/lib/stellar/format";
import type { VaultDetail } from "@/lib/stellar/types";

function Kpi({ label, value, hint, testId }: { label: string; value: React.ReactNode; hint: string; testId?: string }) {
  return (
    <Card className="p-5">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 text-section font-medium tabular-nums" data-testid={testId}>{value}</p>
      <p className="mt-1 text-caption text-muted-foreground">{hint}</p>
    </Card>
  );
}

/** NAV per share, TVL, return and health factor, all read from the vault. */
export function VaultKpis({ vault }: { vault: VaultDetail }) {
  const floor = vault.policy?.limits.min_health_factor_bps;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Kpi label="NAV / share" value={vault.pps ? formatSharePrice(vault.pps) : "—"} hint="USDC per share; 1.000000 at inception" testId="kpi-pps" />
      <Kpi label="TVL" value={vault.nav ? formatUsdc(vault.nav) : vault.navError ? "Unpriced" : "—"} hint={vault.navError ? vault.navError.message : "USDC at strict oracle prices"} testId="kpi-tvl" />
      <Kpi label="Return" value={<ReturnValue bps={vault.returnBps} />} hint={vault.since ? `Since inception (${formatAge(vault.since)})` : "No NAV snapshot yet"} />
      <Kpi
        label="Health factor"
        value={vault.healthFactorBps ? formatHealth(vault.healthFactorBps) : "No debt"}
        hint={floor ? `The vault refuses any call below ${formatHealth(BigInt(floor))}` : "No lending floor"}
        testId="kpi-health"
      />
    </div>
  );
}
