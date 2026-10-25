import { cn } from "cn";
import { shortHash } from "./data";

function Overline({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("font-overline text-caption tracking-overline text-muted-foreground", className)}>
      {children}
    </p>
  );
}

function SectionIntro({
  id,
  overline,
  title,
  lead,
  children,
}: {
  id: string;
  overline: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="max-w-2xl">
      <Overline>{overline}</Overline>
      <h2 id={id} className="mt-4 text-3xl font-light tracking-tight text-heading sm:text-[2.5rem] sm:leading-[1.15]">
        {title}
      </h2>
      {lead && <p className="mt-5 text-lg leading-relaxed text-muted-foreground">{lead}</p>}
      {children}
    </div>
  );
}

function TxLink({ hash, href, label }: { hash: string; href: string; label?: string | undefined }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-baseline gap-2 text-caption text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
      aria-label={`${label ? `${label}: ` : ""}transaction ${hash} on the explorer`}
    >
      {label && <span>{label}</span>}
      <span className="font-mono">{shortHash(hash)}</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export { Overline, SectionIntro, TxLink };
