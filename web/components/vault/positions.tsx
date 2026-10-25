import { formatLimitBps, formatUnits, formatUsdc } from "@/lib/stellar/format";
import type { ExposureView, PositionView } from "@/lib/stellar/types";

const KIND_LABEL: Record<PositionView["kind"], string> = {
  idle: "Idle balance", supply: "Supplied", collateral: "Collateral", debt: "Borrowed", shares: "Vault shares", liquidity: "Pool liquidity",
};

function ExposureBar({ exposure }: { exposure: ExposureView | undefined }) {
  if (!exposure) return <span className="text-caption text-muted-foreground">—</span>;
  const share = Math.max(0, Math.min(100, exposure.bps / 100));
  const cap = Math.min(100, exposure.capBps / 100);
  return (
    <span className="flex flex-wrap items-center gap-2" title={`${formatLimitBps(exposure.bps)} of NAV; the vault refuses any call raising it above ${formatLimitBps(exposure.capBps)}`}>
      <span className="relative h-1.5 w-24 rounded-full bg-secondary">
        <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${share}%` }} />
        <span aria-hidden="true" className="absolute -inset-y-1 w-px bg-foreground/50" style={{ left: `${cap}%` }} />
      </span>
      <span className="text-caption tabular-nums text-muted-foreground">{formatLimitBps(exposure.bps)} / {formatLimitBps(exposure.capBps)}</span>
    </span>
  );
}

/** Holdings per protocol, valued like the vault's NAV, with each protocol's exposure against its cap. */
export function Positions({ positions, exposure }: { positions: PositionView[]; exposure: ExposureView[] }) {
  if (positions.length === 0) return <p className="px-6 pb-6 text-sm text-muted-foreground">No position yet.</p>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-table" data-testid="positions">
          <thead className="border-y text-caption text-muted-foreground">
            <tr>
              <th scope="col" className="py-3 pr-3 pl-6 font-normal">Protocol</th>
              <th scope="col" className="px-3 py-3 font-normal">Position</th>
              <th scope="col" className="px-3 py-3 font-normal">Amount</th>
              <th scope="col" className="px-3 py-3 font-normal">Value</th>
              <th scope="col" className="py-3 pr-6 pl-3 font-normal">Exposure / cap</th>
            </tr>
          </thead>
          <tbody>
            {positions.map(position => (
              <tr key={`${position.protocol}-${position.kind}-${position.asset}`} className="border-b last:border-0">
                <td className="py-3 pr-3 pl-6 font-medium">{position.protocolName}</td>
                <td className="px-3 py-3 text-muted-foreground">{KIND_LABEL[position.kind]}</td>
                <td className="px-3 py-3 tabular-nums">{formatUnits(position.amount, position.assetDecimals, 4)} {position.assetSymbol}</td>
                <td className="px-3 py-3 tabular-nums">{formatUsdc(position.value)} USDC</td>
                <td className="py-3 pr-6 pl-3">{position.protocol === "idle" ? <span className="text-caption text-muted-foreground">Withdrawal buffer</span> : <ExposureBar exposure={exposure.find(entry => entry.protocol === position.protocol)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y border-t md:hidden">
        {positions.map(position => (
          <li key={`${position.protocol}-${position.kind}-${position.asset}`} className="space-y-1 px-4 py-3 text-sm">
            <p className="flex justify-between gap-2"><span className="font-medium">{position.protocolName}</span><span className="tabular-nums">{formatUsdc(position.value)} USDC</span></p>
            <p className="flex justify-between gap-2 text-caption text-muted-foreground"><span>{KIND_LABEL[position.kind]} · {formatUnits(position.amount, position.assetDecimals, 4)} {position.assetSymbol}</span></p>
            {position.protocol !== "idle" && <div className="space-y-1 pt-1"><p className="text-caption text-muted-foreground">Exposure / cap</p><ExposureBar exposure={exposure.find(entry => entry.protocol === position.protocol)} /></div>}
          </li>
        ))}
      </ul>
    </>
  );
}
