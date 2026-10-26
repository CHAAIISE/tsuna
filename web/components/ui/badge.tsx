import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const badgeVariants = cva("inline-flex items-center rounded-sm border px-2.5 py-1 font-display text-xs leading-none font-medium tracking-[0.12em] whitespace-nowrap uppercase", {
  variants: {
    variant: {
      default: "border-border text-foreground",
      secondary: "border-border text-muted-foreground",
      success: "border-success/40 text-success",
      destructive: "border-destructive/40 text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});

function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
