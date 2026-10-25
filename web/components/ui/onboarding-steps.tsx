import { Check } from "lucide-react";
import { cn } from "cn";

const onboardingSteps = [
  "Create your passkey",
  "Get test USDC",
  "Pick an agent and deposit",
  "Watch it work (and try to break it)",
] as const;

function OnboardingSteps({ currentStep }: { currentStep: 0 | 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="Getting started" data-testid="onboarding-steps" className="rounded-xl border bg-card px-4 py-4 sm:px-6">
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {onboardingSteps.map((label, index) => (
          <li key={label} aria-current={index === currentStep ? "step" : undefined} className="flex items-start gap-3 text-caption">
            <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border font-medium", index === currentStep ? "border-primary bg-primary text-primary-foreground" : index < currentStep ? "border-primary/20 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{index < currentStep ? <Check className="size-3" /> : index + 1}</span>
            <span className={cn("pt-1", index > currentStep && "text-muted-foreground")}><span className="sr-only">Step {index + 1}{index < currentStep ? ", completed" : ""}: </span>{label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export { OnboardingSteps };
