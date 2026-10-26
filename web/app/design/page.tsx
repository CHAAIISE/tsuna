import { notFound } from "next/navigation";
import { Logo } from "@/components/logo";
import { ArrowDownToLine, ArrowRight, LockKeyhole } from "lucide-react";
import { AppNavigation } from "@/components/ui/app-navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { OnboardingSteps } from "@/components/ui/onboarding-steps";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";

const swatches = [
  ["Background", "bg-background"], ["Surface", "bg-card"],
  ["Action", "bg-primary"], ["Heading", "bg-heading"],
  ["Success", "bg-success"], ["Loss", "bg-loss"],
  ["Blocked", "bg-destructive"], ["Blocked surface", "bg-destructive-soft"],
] as const;

export default function DesignPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
      <AppNavigation />
      <PageLayout>
        <PageHeader title="A measured kind of control." description="Tsuna design system. Clear actions, quiet surfaces, unmistakable boundaries." aside={<Badge variant="secondary">Component library · development only</Badge>} />
        <OnboardingSteps currentStep={1} />
        <div className="grid items-start gap-8 lg:grid-cols-3">
          <section className="space-y-8 lg:col-span-2" aria-label="Design foundations">
            <Card>
              <CardHeader><p className="font-overline text-caption tracking-overline text-muted-foreground">Type & hierarchy</p><CardTitle>Agents propose. The chain decides.</CardTitle><CardDescription>Inter for the product. Cormorant for the editorial voice.</CardDescription></CardHeader>
              <CardContent className="space-y-6">
                <p className="text-page font-normal tracking-tight">Rules, not reassurance.</p>
                <p className="max-w-lg text-base text-muted-foreground">Every action should explain what happens next. Every refusal should explain what the chain protected.</p>
                <p className="font-editorial text-4xl font-medium text-heading">The chain holds the rope.</p>
                <div className="flex flex-wrap gap-2"><Badge>On-chain rules</Badge><Badge variant="success">Authorized</Badge><Badge variant="destructive">Blocked</Badge><Badge variant="secondary">Testnet only</Badge></div>
              </CardContent>
              <CardFooter><Button asChild data-primary><a href="#components">Explore components <ArrowRight aria-hidden="true" /></a></Button><Button asChild variant="outline"><a href="#states">View feedback states</a></Button></CardFooter>
            </Card>
            <Card>
              <CardHeader><CardTitle>A name with a boundary</CardTitle><CardDescription>The serif T&apos;s crossbar runs into a mooring loop. The loop is the only blue accent.</CardDescription></CardHeader>
              <CardContent className="flex flex-wrap items-end gap-8">
                <Logo className="h-12" />
                <div className="flex items-end gap-6">
                  <Logo markOnly className="size-4" />
                  <Logo markOnly className="size-8" />
                  <Logo markOnly className="size-16" />
                </div>
              </CardContent>
            </Card>
            <Card id="components">
              <CardHeader><CardTitle>Actions & inputs</CardTitle><CardDescription>Primary, secondary, pending and disabled states.</CardDescription></CardHeader>
              <CardContent className="space-y-6">
                <div className="flex flex-wrap gap-3"><Button asChild variant="outline"><a href="#amount"><ArrowDownToLine aria-hidden="true" /> Focus on the amount</a></Button><Button pending>Waiting for Stellar…</Button><Button disabled>Unavailable</Button><Button asChild variant="ghost"><a href="#palette">View palette</a></Button></div>
                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2"><label htmlFor="amount" className="text-sm font-medium">Amount in USDC</label><Input id="amount" type="text" inputMode="decimal" placeholder="0.00" aria-describedby="amount-help" /><p id="amount-help" className="text-caption text-muted-foreground">Test tokens only. No real funds.</p></div>
                  <div className="space-y-2"><label htmlFor="invalid-amount" className="text-sm font-medium">Invalid amount</label><Input id="invalid-amount" defaultValue="-1" aria-invalid="true" aria-describedby="amount-error" /><p id="amount-error" className="text-caption text-destructive">Enter an amount greater than zero.</p></div>
                </div>
              </CardContent>
            </Card>
          </section>
          <aside className="space-y-8" aria-label="Feedback and palette">
            <Card id="states">
              <CardHeader><CardTitle>When the chain says no</CardTitle><CardDescription>Refusals get the only crimson surface.</CardDescription></CardHeader>
              <CardContent>
                <div className="space-y-3 rounded-lg border-l-3 border-destructive bg-destructive-soft p-4 text-sm">
                  <div className="flex items-center gap-2 font-medium text-destructive"><LockKeyhole aria-hidden="true" className="size-4" /> Destination blocked</div>
                  <p>The destination must be the vault. Choose the vault address and try again.</p>
                  <details className="text-caption"><summary className="text-destructive">Details</summary><p className="mt-3 break-words font-mono">DestinationNotVault</p><p className="mt-2 text-muted-foreground">Component preview, not a submitted transaction.</p></details>
                </div>
              </CardContent>
            </Card>
            <Card id="palette">
              <CardHeader><CardTitle>Quiet until it matters</CardTitle><CardDescription>Blue for action. Crimson for a boundary.</CardDescription></CardHeader>
              <CardContent><ul className="grid grid-cols-2 gap-4">{swatches.map(([name, color]) => <li key={name} className="space-y-2"><div aria-hidden="true" className={`h-8 rounded-md border ${color}`} /><p className="text-caption text-muted-foreground">{name}</p></li>)}</ul></CardContent>
            </Card>
          </aside>
        </div>
        <footer className="border-t py-6 text-caption text-muted-foreground">Tsuna · Stellar testnet · No real funds.</footer>
      </PageLayout>
    </>
  );
}
