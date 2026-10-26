const title = "Agent proposes, Tsuna checks, protocols execute";
const desc =
  "The agent holds a session key and proposes a call. The Tsuna vault checks the call, runs it, then checks the result in the same transaction. Allowed calls reach Blend, DeFindex, Soroswap and Aquarius. Anything off reverts the whole transaction.";

function Wide() {
  return (
    <svg viewBox="0 0 1000 320" role="img" aria-labelledby="flow-wide-title flow-wide-desc" className="hidden h-auto w-full md:block">
      <title id="flow-wide-title">{title}</title>
      <desc id="flow-wide-desc">{desc}</desc>
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M0 1 9 5 0 9" fill="none" className="stroke-muted-foreground" strokeWidth="1.5" />
        </marker>
        <marker id="flow-stop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M0 1 9 5 0 9" fill="none" className="stroke-destructive" strokeWidth="1.5" />
        </marker>
      </defs>

      <rect x="10" y="66" width="250" height="148" rx="20" className="fill-card stroke-border" strokeWidth="1.5" />
      <text x="36" y="106" className="fill-muted-foreground text-[13px] tracking-[0.12em]">01</text>
      <text x="36" y="140" className="fill-heading text-[22px] font-medium">Agent</text>
      <text x="36" y="168" className="fill-muted-foreground text-[14px]">Holds a session key,</text>
      <text x="36" y="188" className="fill-muted-foreground text-[14px]">never the funds</text>

      <path d="M260 140h104" className="stroke-primary" strokeWidth="1.5" />
      <circle cx="371" cy="140" r="6" className="fill-background stroke-primary" strokeWidth="1.5" />
      <text x="316" y="126" textAnchor="middle" className="fill-muted-foreground text-[13px]">proposes</text>

      <rect x="378" y="40" width="270" height="200" rx="20" className="fill-card stroke-primary" strokeWidth="1.5" />
      <text x="404" y="82" className="fill-muted-foreground text-[13px] tracking-[0.12em]">02</text>
      <text x="404" y="120" className="fill-heading font-editorial text-[34px] font-semibold">Tsuna</text>
      <text x="404" y="152" className="fill-muted-foreground text-[14px]">1. Checks the call</text>
      <text x="404" y="176" className="fill-muted-foreground text-[14px]">2. Runs it</text>
      <text x="404" y="200" className="fill-muted-foreground text-[14px]">3. Checks the result</text>
      <text x="404" y="224" className="fill-muted-foreground text-[12px]">one transaction</text>

      <path d="M648 140h88" className="stroke-muted-foreground" strokeWidth="1.5" markerEnd="url(#flow-arrow)" />
      <text x="692" y="126" textAnchor="middle" className="fill-muted-foreground text-[13px]">allowed</text>

      <rect x="740" y="66" width="250" height="148" rx="20" className="fill-card stroke-border" strokeWidth="1.5" />
      <text x="766" y="106" className="fill-muted-foreground text-[13px] tracking-[0.12em]">03</text>
      <text x="766" y="140" className="fill-heading text-[22px] font-medium">Protocols</text>
      <text x="766" y="168" className="fill-muted-foreground text-[14px]">Blend · DeFindex</text>
      <text x="766" y="188" className="fill-muted-foreground text-[14px]">Soroswap · Aquarius</text>

      <path d="M513 240v42" className="stroke-destructive" strokeWidth="1.5" markerEnd="url(#flow-stop)" />
      <text x="530" y="300" className="fill-destructive text-[14px] font-medium">Anything off: the whole transaction reverts</text>
    </svg>
  );
}

function Tall() {
  return (
    <svg viewBox="0 0 340 520" role="img" aria-labelledby="flow-tall-title flow-tall-desc" className="h-auto w-full md:hidden">
      <title id="flow-tall-title">{title}</title>
      <desc id="flow-tall-desc">{desc}</desc>
      <defs>
        <marker id="flow-arrow-tall" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M0 1 9 5 0 9" fill="none" className="stroke-muted-foreground" strokeWidth="1.5" />
        </marker>
      </defs>

      <rect x="1" y="1" width="338" height="96" rx="20" className="fill-card stroke-border" strokeWidth="1.5" />
      <text x="22" y="40" className="fill-heading text-[20px] font-medium">Agent</text>
      <text x="22" y="68" className="fill-muted-foreground text-[14px]">Holds a session key, never the funds</text>

      <path d="M170 97v50" className="stroke-primary" strokeWidth="1.5" />
      <circle cx="170" cy="153" r="6" className="fill-background stroke-primary" strokeWidth="1.5" />
      <text x="184" y="128" className="fill-muted-foreground text-[13px]">proposes</text>

      <rect x="1" y="160" width="338" height="200" rx="20" className="fill-card stroke-primary" strokeWidth="1.5" />
      <text x="22" y="204" className="fill-heading font-editorial text-[32px] font-semibold">Tsuna</text>
      <text x="22" y="236" className="fill-muted-foreground text-[14px]">1. Checks the call</text>
      <text x="22" y="260" className="fill-muted-foreground text-[14px]">2. Runs it</text>
      <text x="22" y="284" className="fill-muted-foreground text-[14px]">3. Checks the result, same transaction</text>
      <line x1="22" x2="318" y1="306" y2="306" className="stroke-border" strokeWidth="1" />
      <text x="22" y="334" className="fill-destructive text-[13px] font-medium">Anything off: the transaction reverts</text>

      <path d="M170 360v54" className="stroke-muted-foreground" strokeWidth="1.5" markerEnd="url(#flow-arrow-tall)" />
      <text x="184" y="392" className="fill-muted-foreground text-[13px]">allowed</text>

      <rect x="1" y="422" width="338" height="96" rx="20" className="fill-card stroke-border" strokeWidth="1.5" />
      <text x="22" y="461" className="fill-heading text-[20px] font-medium">Protocols</text>
      <text x="22" y="489" className="fill-muted-foreground text-[14px]">Blend · DeFindex · Soroswap · Aquarius</text>
    </svg>
  );
}

function FlowDiagram() {
  return (
    <div className="rounded-xl border bg-background p-5 sm:p-8">
      <Wide />
      <Tall />
    </div>
  );
}

export { FlowDiagram };
