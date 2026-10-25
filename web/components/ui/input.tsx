import type { ComponentProps } from "react";
import { cn } from "cn";

function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn("h-12 w-full min-w-0 rounded-lg border border-input bg-card px-4 text-base transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-secondary disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-destructive/20", className)} {...props} />;
}

export { Input };
