import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { AppNavigation } from "@/components/ui/app-navigation";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";
import { BridgeTracker } from "./bridge-tracker";

export const metadata: Metadata = {
  title: "Deposit from Ethereum — Leash",
  description: "Bring USDC from Ethereum Sepolia to a Leash vault on Stellar with CCTP.",
};

export default function BridgePage() {
  return (
    <>
      <AppNavigation activePath="/bridge" accountAction={<Badge>Stellar testnet</Badge>} />
      <PageLayout>
        <PageHeader title="Deposit from Ethereum" description="Bring USDC from Sepolia with CCTP." />
        <BridgeTracker />
      </PageLayout>
    </>
  );
}
