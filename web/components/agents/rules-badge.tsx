import { LockKeyhole } from "lucide-react";
import type { RuleCount } from "@/lib/stellar/types";

/** Number of on-chain rules the vault enforces (allowlisted calls plus limits). */
export function RulesBadge({ rules }: { rules: RuleCount | null }) {
  if (!rules) return <span className="text-caption text-muted-foreground">No policy</span>;
  return (
    <span
      title={`${rules.calls} allowlisted calls and ${rules.limits} limits, read from the policy registry`}
      className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-caption font-medium whitespace-nowrap"
    >
      <LockKeyhole aria-hidden="true" className="size-3 text-primary" />
      {rules.total} rules
    </span>
  );
}
