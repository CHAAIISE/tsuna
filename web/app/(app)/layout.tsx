import type { ReactNode } from "react";
import { AppNavigation } from "@/components/ui/app-navigation";
import { QueryProvider } from "@/lib/hooks/query-provider";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:p-4">Skip to content</a>
      <AppNavigation />
      {children}
    </QueryProvider>
  );
}
