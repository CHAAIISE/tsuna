import type { ReactNode } from "react";
import { QueryProvider } from "@/lib/hooks/query-provider";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
