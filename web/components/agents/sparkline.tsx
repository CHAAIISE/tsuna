import { ppsSeries, sparklinePath } from "@/lib/stellar/format";
import type { SnapshotPoint } from "@/lib/stellar/types";

const WIDTH = 96;
const HEIGHT = 28;

/** Price-per-share history from `NavSnapshot` events: green when up, pink when down. */
export function Sparkline({ points, label }: { points: SnapshotPoint[]; label: string }) {
  if (points.length === 0) return <span className="text-caption text-muted-foreground">No snapshot</span>;
  const series = ppsSeries(points);
  const last = series.at(-1) ?? 0;
  const tone = last > 0 ? "text-success" : last < 0 ? "text-loss" : "text-muted-foreground";
  return (
    <svg role="img" aria-label={`${label}: ${points.length} on-chain snapshots`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={WIDTH} height={HEIGHT} className={tone}>
      <path d={sparklinePath(series, WIDTH, HEIGHT)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
