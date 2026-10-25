import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const badgeVariants = cva("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-caption font-medium whitespace-nowrap", {
  variants: {
    variant: {
      default: "border-border bg-card text-foreground",
      secondary: "border-transparent bg-chip text-muted-foreground",
      success: "border-success/20 bg-success/10 text-foreground before:size-1.5 before:rounded-full before:bg-success",
      destructive: "border-destructive/20 bg-destructive-soft text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
