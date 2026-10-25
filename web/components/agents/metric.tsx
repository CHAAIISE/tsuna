import { cn } from "cn";
import { formatBps } from "@/lib/stellar/format";

/** Signed return in bps, green for gains and pink for losses. */
export function ReturnValue({ bps, className }: { bps: number | null; className?: string }) {
  if (bps === null) return <span className={cn("text-muted-foreground", className)}>—</span>;
  const tone = bps > 0 ? "text-success" : bps < 0 ? "text-loss" : "text-foreground";
  return <span className={cn("tabular-nums", tone, className)}>{formatBps(bps)}</span>;
}

/** Worst fall from a previous peak, shown as a loss when there was one. */
export function DrawdownValue({ bps, className }: { bps: number | null; className?: string }) {
  if (bps === null) return <span className={cn("text-muted-foreground", className)}>—</span>;
  return <span className={cn("tabular-nums", bps > 0 ? "text-loss" : "text-muted-foreground", className)}>{bps > 0 ? formatBps(-bps) : "0.00%"}</span>;
}
