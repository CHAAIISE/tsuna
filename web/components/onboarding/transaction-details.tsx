import { EXPLORER_URL } from "@/lib/passkey/deployment";

export interface DetailRow {
  label: string;
  value: string;
  kind: "account" | "contract" | "tx";
  testId?: string;
}

const explorerPath = { account: "account", contract: "contract", tx: "tx" } as const;

/** Addresses and hashes, folded behind "Details" as the design asks. */
export function TransactionDetails({ rows }: { rows: DetailRow[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="group text-caption">
      <summary className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">Details</summary>
      <dl className="mt-3 space-y-3">
        {rows.map(row => (
          <div key={`${row.label}-${row.value}`} className="space-y-1">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd>
              <a
                href={`${EXPLORER_URL}/${explorerPath[row.kind]}/${row.value}`}
                target="_blank"
                rel="noreferrer"
                data-testid={row.testId}
                className="break-all font-mono text-foreground underline-offset-4 hover:text-primary hover:underline"
              >
                {row.value}
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
