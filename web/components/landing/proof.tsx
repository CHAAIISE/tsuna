import { cn } from "cn";
import { explorerTx, proofs, type ProofItem } from "./data";
import { SectionIntro, TxLink } from "./section";

function ProofRow({ item }: { item: ProofItem }) {
  const refused = item.outcome === "refused";
  return (
    <li
      className={cn(
        "grid gap-3 px-5 py-5 sm:px-6 md:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,3fr)] md:items-baseline md:gap-8",
        refused ? "border-l-[3px] border-destructive bg-destructive-soft" : "border-l-[3px] border-transparent",
      )}
    >
      <div>
        <p className={cn("flex items-center gap-2 text-caption", refused ? "text-destructive" : "text-muted-foreground")}>
          {!refused && <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />}
          {refused ? "Refused on-chain" : "Allowed"}
        </p>
        <p className={cn("mt-1 font-medium break-words", refused ? "text-destructive" : "text-heading")}>{item.name}</p>
      </div>
      <p className="leading-relaxed text-muted-foreground">{item.meaning}</p>
      <ul className="flex flex-col gap-1.5">
        {item.txs.map(tx => (
          <li key={tx.hash}>
            <TxLink hash={tx.hash} href={tx.href ?? explorerTx(tx.hash)} label={tx.label} />
          </li>
        ))}
      </ul>
    </li>
  );
}

function Proof() {
  const refused = proofs.filter(item => item.outcome === "refused");
  const allowed = proofs.filter(item => item.outcome === "allowed");
  return (
    <section id="proof" aria-labelledby="proof-title" className="page-x border-t bg-muted py-20 sm:py-24">
      <SectionIntro
        id="proof-title"
        overline="Proof"
        title={<>Don&apos;t take our word for it. <span className="font-editorial text-[1.1em] italic">Open the transactions.</span></>}
        lead="Every row is a real transaction on Stellar. Refused calls were still submitted, so the failure and its error code live in the ledger."
      />
      <h3 className="mt-14 text-subheading font-medium text-heading">Refused</h3>
      <ul className="mt-4 space-y-2">
        {refused.map(item => <ProofRow key={item.name} item={item} />)}
      </ul>
      <h3 className="mt-12 text-subheading font-medium text-heading">Allowed</h3>
      <ul className="mt-4 divide-y rounded-xl border bg-card">
        {allowed.map(item => <ProofRow key={item.name} item={item} />)}
      </ul>
    </section>
  );
}

export { Proof };
