import Link from "next/link";
import { Overline } from "./section";

/** Known gaps, from our own review and an external one. Each has a fix planned; none is hidden. */
const gaps = [
  {
    title: "The demo price switch is immediate",
    body: "Feed and configuration changes now wait out a public timelock, but the demo router keeps its demo switch: its admin can force a price at once, which the crash scenario needs. The production build has no such function.",
  },
  {
    title: "Oracle lag",
    body: "Deposits and withdrawals price at the latest Reflector update (about every 5 minutes), with no entry or exit fee. Someone who sees the market move first can trade against that lag. Fix: a small exit fee or a one-update delay.",
  },
  {
    title: "Exits on leveraged vaults",
    body: "A leveraged vault repays debt only from idle USDC, so after the first large withdrawal the next ones can fail with RepaymentUnavailable until the agent or the risk-off role frees more. A protocol that reverts also blocks exits.",
  },
  {
    title: "Smaller ones",
    body: "Only BTC has a second price source (Chainlink); USDC and XLM rely on Reflector alone. A deposit sent before a vault's policy is registered locks it. The protocol watch trusts the first code hash it sees and not the protocols' own dependencies. The app's rate limits are kept per server instance.",
  },
] as const;

function Limits() {
  return (
    <section id="limits" aria-labelledby="limits-title" className="page-x border-t bg-muted py-20 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <Overline>Limits</Overline>
          <h2 id="limits-title" className="mt-4 text-3xl font-light tracking-tight text-heading sm:text-[2.5rem] sm:leading-[1.15]">
            What it doesn&apos;t protect against
          </h2>
        </div>
        <div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
          <p>
            Tsuna stops the agent from moving value out of the vault. It can&apos;t make Blend, Soroswap or any
            other protocol unhackable: once funds sit in a protocol, they share its risk.
          </p>
          <p>
            What bounds that loss is the exposure cap on each protocol and the pause when a drawdown passes the limit.
            The agent can also lose money inside its rules, within the per-call tolerance and the daily loss budget.
            Tsuna bounds the worst case; it doesn&apos;t promise returns.
          </p>
        </div>
      </div>
      <h3 className="mt-16 text-subheading font-medium text-heading">Known gaps</h3>
      <dl className="mt-4 border-b">
        {gaps.map(gap => (
          <div key={gap.title} className="grid gap-2 border-t py-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-12">
            <dt className="font-medium text-heading">{gap.title}</dt>
            <dd className="leading-relaxed text-muted-foreground">{gap.body}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Closing() {
  return (
    <section id="start" aria-labelledby="closing-title" className="page-x border-t bg-background py-20 sm:py-28">
      <p className="font-display text-sm tracking-[0.2em] text-primary uppercase">Start</p>
      <h2 id="closing-title" className="mt-5 max-w-3xl font-editorial text-5xl leading-[1.05] font-medium text-heading sm:text-6xl">
        Try to break it. <span className="italic">Watch the chain say no.</span>
      </h2>
      <div className="mt-10 flex flex-wrap gap-4">
        {[
          { href: "/agents", label: "Explore agents" },
          { href: "/onboarding", label: "Create your passkey" },
        ].map(link => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-sm border border-primary/70 bg-card px-7 py-3.5 font-display text-sm tracking-[0.14em] text-primary uppercase shadow-glow transition-[background-color,color,box-shadow] hover:bg-primary hover:text-primary-foreground hover:shadow-glow-strong"
          >
            {link.label}
          </Link>
        ))}
      </div>
    </section>
  );
}

const footerLinks = [
  { href: "/#how", label: "How it works" },
  { href: "/docs", label: "Docs" },
  { href: "/agents", label: "Launch app" },
  { href: "https://github.com/CHAAIISE/tsuna", label: "GitHub" },
] as const;

function LandingFooter() {
  return (
    <footer className="relative overflow-hidden border-t bg-background pt-16">
      <nav aria-label="Footer">
        <ul className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 text-sm text-muted-foreground">
          {footerLinks.map(link => (
            <li key={link.href}>
              <Link href={link.href} className="transition-colors hover:text-primary">{link.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-6 text-center text-caption text-muted-foreground/80">© 2026 Tsuna · built on Stellar for HackMeridian</p>
      {/* Giant wordmark cut by the page edge, fading from brand red into the background. */}
      <div aria-hidden="true" className="mt-10 h-[0.62em] overflow-hidden text-center font-display text-[clamp(5rem,23vw,24rem)] leading-none font-medium tracking-[0.12em] select-none [padding-left:0.12em]">
        <span className="bg-linear-to-b from-primary/25 via-primary/10 to-transparent bg-clip-text text-transparent">TSUNA</span>
      </div>
    </footer>
  );
}

export { Closing, LandingFooter, Limits };
