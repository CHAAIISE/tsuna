import type { Metadata } from "next";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";
import { BridgeTracker } from "./bridge-tracker";

export const metadata: Metadata = {
  title: "Deposit from Ethereum — Tsuna",
  description: "Bring USDC from Ethereum Sepolia to a Tsuna vault on Stellar with CCTP.",
};

export default function BridgePage() {
  return (
    <>
      <PageLayout>
        <PageHeader title="Deposit from Ethereum" description="Bring USDC from Sepolia with CCTP." />
        <BridgeTracker />
      </PageLayout>
    </>
  );
}
