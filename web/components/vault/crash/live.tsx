import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import type { CrashLiveView } from "@/lib/crash/types";
import { formatHealth, formatLimitBps, formatUnits, formatUsdc } from "@/lib/stellar/format";

function Metric({ label, value, hint, testId, loss = false }: { label: string; value: React.ReactNode; hint: string; testId?: string; loss?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 text-subheading font-medium tabular-nums", loss && "text-loss")} data-testid={testId}>{value}</dd>
      <dd className="mt-0.5 text-caption text-muted-foreground">{hint}</dd>
    </div>
  );
}

/** XLM price, health factor, NAV and pause of the crash vault, read from the chain every few seconds. */
export function CrashLive({ live }: { live: CrashLiveView }) {
  const floor = BigInt(live.minHealthBps);
  const health = live.healthFactorBps === null ? null : BigInt(live.healthFactorBps);
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border lg:grid-cols-4" aria-live="polite">
      <Metric
        label="XLM price"
        value={live.xlmPrice ? `${formatUnits(live.xlmPrice, 7, 4)} USDC` : "Unpriced"}
        hint={live.forcedPrice ? "Forced by the demo oracle" : "From the oracle's sources"}
        testId="crash-xlm-price"
      />
      <Metric
        label="Health factor"
        value={health === null ? "No debt" : formatHealth(health)}
        hint={`The vault refuses calls under ${formatHealth(floor)}`}
        loss={health !== null && health < floor}
        testId="crash-health"
      />
      <Metric label="NAV" value={live.nav ? `${formatUsdc(live.nav)} USDC` : "Unpriced"} hint="At the vault's oracle prices" testId="crash-nav" />
      <Metric
        label="Vault"
        value={live.paused
          ? <Badge variant="destructive" data-testid="crash-paused">Paused</Badge>
          : <Badge variant="success" data-testid="crash-running">Running</Badge>}
        hint={`Pauses past a ${formatLimitBps(live.maxDrawdownBps)} drop in price per share`}
      />
    </dl>
  );
}
