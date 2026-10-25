import type { ComponentProps, ReactNode } from "react";
import { cn } from "cn";

function PageLayout({ className, ...props }: ComponentProps<"main">) {
  return <main id="main-content" className={cn("mx-auto w-full max-w-app space-y-8 px-4 py-8 sm:px-6 lg:px-0 lg:py-12", className)} {...props} />;
}

function PageHeader({ title, description, aside }: { title: string; description: string; aside?: ReactNode }) {
  return <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0 space-y-2"><h1 className="text-page font-normal tracking-tight">{title}</h1><p className="text-base text-muted-foreground">{description}</p></div>{aside && <div className="shrink-0">{aside}</div>}</div>;
}

export { PageLayout, PageHeader };
