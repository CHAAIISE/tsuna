import { Clock, LockKeyhole, ShieldCheck } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { explorerAccount, formatHealth, formatLimitBps, formatUsdc, shortAddress } from "@/lib/stellar/format";
import type { RoleView, VaultDetail } from "@/lib/stellar/types";
import { ProtocolWatch } from "@/components/attack/protocol-watch";

const ARG_LABEL: Record<string, string> = {
  Any: "any value",
  Vault: "must be the vault",
  Protocol: "must be an allowlisted protocol",
  Amount: "amount, counted against the caps",
  BlendRequests: "Blend requests, assets and recipients checked",
  Assets: "allowed assets only",
};

const units = (nav: string | null, bps: number) => nav ? BigInt(nav) * BigInt(bps) / 10_000n : null;

function Meter({ used, limit, label }: { used: bigint; limit: bigint | null; label: string }) {
  const ratio = limit && limit > 0n ? Math.min(1, Number(used * 10_000n / limit) / 10_000) : 0;
  return (
    <span className="mt-2 block h-1.5 w-full rounded-full bg-secondary" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
      <span className="block h-full rounded-full bg-primary" style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

function Limit({ label, value, hint, children }: { label: string; value: string; hint: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-caption text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium tabular-nums">{value}</p>
      {children}
      <p className="mt-2 text-caption text-muted-foreground">{hint}</p>
    </div>
  );
}

function RoleBudget({ role, nav }: { role: RoleView; nav: string | null }) {
  const lossBudget = units(nav, role.quota.daily_loss_bps);
  const lost = BigInt(role.dailyLoss ?? "0");
  const remaining = lossBudget === null ? null : lossBudget > lost ? lossBudget - lost : 0n;
  const dailyCap = units(nav, role.quota.daily_cap_bps);
  const spent = BigInt(role.usage?.spentToday ?? "0");
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Limit label="Per-call cap" value={`${formatLimitBps(role.quota.tx_cap_bps)} of NAV`} hint={nav ? `${formatUsdc(units(nav, role.quota.tx_cap_bps) ?? 0n)} USDC at the current NAV` : "Of the NAV at call time"} />
      <Limit label="Daily volume" value={`${formatUsdc(spent)} / ${dailyCap === null ? "—" : formatUsdc(dailyCap)} USDC`} hint={`Cap ${formatLimitBps(role.quota.daily_cap_bps)} of NAV per UTC day`}>
        <Meter used={spent} limit={dailyCap} label={`${role.name} daily volume used`} />
      </Limit>
      <Limit label="Calls this hour" value={`${role.usage?.callsThisHour ?? 0} / ${role.quota.calls_per_hour}`} hint="Rate limit per UTC hour">
        <Meter used={BigInt(role.usage?.callsThisHour ?? 0)} limit={BigInt(role.quota.calls_per_hour)} label={`${role.name} calls this hour`} />
      </Limit>
      <Limit
        label="Daily loss budget"
        value={remaining === null ? `${formatLimitBps(role.quota.daily_loss_bps)} of NAV` : `${formatUsdc(remaining, 4)} USDC left`}
        hint={`Used ${formatUsdc(lost, 4)} of ${lossBudget === null ? "—" : formatUsdc(lossBudget, 4)} USDC over 24 h (${formatLimitBps(role.quota.daily_loss_bps)})`}
      >
        <Meter used={lost} limit={lossBudget} label={`${role.name} daily loss budget used`} />
      </Limit>
    </div>
  );
}

function RoleCard({ role, nav }: { role: RoleView; nav: string | null }) {
  const riskOff = role.mode === "RiskOff";
  return (
    <Card data-testid={`role-${role.name}`}>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex min-w-0 items-start gap-2">{riskOff ? <ShieldCheck aria-hidden="true" className="mt-1 size-4 shrink-0 text-primary" /> : <LockKeyhole aria-hidden="true" className="mt-1 size-4 shrink-0 text-primary" />}{role.name === "default" ? "Yield agent (default role)" : `${role.name === "riskoff" ? "Risk-off agent" : role.name} (${role.name} role)`}</CardTitle>
          <span className="max-w-full rounded-lg bg-chip px-2.5 py-1 text-caption text-muted-foreground">{riskOff ? "RiskOff mode: acts while paused, may only reduce risk" : "Normal mode"}</span>
        </div>
        <CardDescription>
          Signed by <a href={explorerAccount(role.member)} target="_blank" rel="noreferrer" className="hover:text-primary" title={role.member}>{shortAddress(role.member)}</a>.
          {riskOff ? " The vault checks the outcome of every call: health factor not lower, no exposure higher, no value out — else RiskIncreased." : " Every call is checked before and after it runs."}
        </CardDescription>
      </CardHeader>
      <div className="space-y-5 px-6 pb-6">
        <RoleBudget role={role} nav={nav} />
        <div className="overflow-x-auto">
          <table className="block w-full text-left text-sm sm:table">
            <caption className="block pb-2 text-left text-caption text-muted-foreground sm:table-caption">{role.calls.length} allowlisted {role.calls.length === 1 ? "call" : "calls"} — anything else is refused with CallNotAllowed</caption>
            <thead className="hidden border-b text-caption text-muted-foreground sm:table-header-group">
              <tr><th scope="col" className="py-2 pr-3 font-normal">Contract · function</th><th scope="col" className="px-3 py-2 font-normal">Arguments</th><th scope="col" className="px-3 py-2 font-normal">Max loss</th><th scope="col" className="py-2 pl-3 font-normal">Preset</th></tr>
            </thead>
            <tbody className="block sm:table-row-group">
              {role.calls.map(call => (
                <tr key={`${call.target}-${call.fn}`} className="grid grid-cols-2 gap-3 border-b py-4 align-top last:border-0 sm:table-row sm:py-0">
                  <td className="col-span-2 block break-words sm:table-cell sm:py-2 sm:pr-3"><span className="font-medium">{call.targetName}</span> · <span className="text-caption break-all">{call.fn}</span></td>
                  <td className="col-span-2 block text-muted-foreground sm:table-cell sm:px-3 sm:py-2">
                    <p className="mb-1 text-caption font-medium text-foreground sm:hidden">Arguments</p>
                    <ol className="list-decimal space-y-0.5 pl-4 text-caption">{call.args.map((arg, i) => <li key={i}>{ARG_LABEL[arg] ?? arg}</li>)}</ol>
                    {call.approve && <p className="mt-1 text-caption">Vault issues an exact approve, cleared after the call</p>}
                  </td>
                  <td className="block tabular-nums sm:table-cell sm:px-3 sm:py-2"><span className="mb-1 block text-caption text-muted-foreground sm:hidden">Max loss</span>{formatLimitBps(call.maxLossBps)}</td>
                  <td className="block text-muted-foreground sm:table-cell sm:py-2 sm:pl-3"><span className="mb-1 block text-caption sm:hidden">Preset</span>{call.preset ?? "Custom"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

/** The leash: everything the vault checks on-chain, with live usage of each budget. */
export function LeashRules({ vault }: { vault: VaultDetail }) {
  const policy = vault.policy;
  if (!policy) return <p className="text-sm text-muted-foreground">The creator has not registered this vault&apos;s policy yet: the agent cannot act (PolicyMissing).</p>;
  const { limits } = policy;
  return (
    <div className="space-y-6" data-testid="leash-rules">
      {policy.pendingEta && (
        <p className="flex items-center gap-2 rounded-lg border bg-card px-4 py-3 text-sm"><Clock aria-hidden="true" className="size-4 text-primary" />A loosening of these rules is waiting for its public timelock until {new Date(policy.pendingEta * 1000).toLocaleString("en-US")}. Tightening applies at once.</p>
      )}
      <section aria-label="Vault-wide limits" className="space-y-3">
        <h3 className="text-subheading font-medium">Vault-wide limits</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Limit label="Health factor floor" value={formatHealth(BigInt(limits.min_health_factor_bps))} hint={vault.healthFactorBps ? `Now ${formatHealth(vault.healthFactorBps)}` : "No debt now"} />
          <Limit label="Drawdown breaker" value={`${formatLimitBps(limits.max_drawdown_bps)} from the 24 h peak`} hint="Anyone can call check_drawdown; past it, the vault pauses" />
          <Limit label="Default exposure cap" value={`${formatLimitBps(limits.max_exposure_bps)} of NAV per protocol`} hint="Unless a protocol has its own cap below" />
          <Limit label="Assets allowed" value={policy.assets.map(asset => asset.symbol).join(", ")} hint="Any other asset is refused with AssetNotAllowed" />
        </div>
      </section>
      {(vault.exposure.length > 0 || policy.exposureCaps.length > 0) && (
        <section aria-label="Exposure caps" className="space-y-3">
          <h3 className="text-subheading font-medium">Exposure caps</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {policy.protocols.map(protocol => {
              const exposure = vault.exposure.find(entry => entry.protocol === protocol.address);
              const cap = policy.exposureCaps.find(entry => entry.protocol === protocol.address)?.bps ?? limits.max_exposure_bps;
              return (
                <Limit key={protocol.address} label={protocol.name} value={`${formatLimitBps(exposure?.bps ?? 0)} / ${formatLimitBps(cap)}`} hint="Share of NAV now / cap; a call raising it above is refused">
                  <Meter used={BigInt(exposure?.bps ?? 0)} limit={BigInt(cap)} label={`${protocol.name} exposure`} />
                </Limit>
              );
            })}
          </div>
        </section>
      )}
      <ProtocolWatch id={vault.id} />
      <section aria-label="Roles" className="space-y-3">
        <h3 className="text-subheading font-medium">Roles</h3>
        {vault.roleViews.length === 0 && <p className="text-sm text-muted-foreground">No role can act: the session key is revoked and no other role is defined.</p>}
        {vault.roleViews.map(role => <RoleCard key={role.name} role={role} nav={vault.nav} />)}
      </section>
    </div>
  );
}
