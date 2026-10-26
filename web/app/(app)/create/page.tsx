import type { Metadata } from "next";
import { CreateFlow } from "@/components/create/create-flow";
import { PageHeader, PageLayout } from "@/components/ui/page-layout";
import { serverKey } from "@/lib/fleet/config";
import { publisherAccount, presetCatalog } from "@/lib/fleet/create";

export const metadata: Metadata = {
  title: "Publish an agent — Tsuna",
  description: "Choose a strategy, then the rules its agent can never break. The vault is deployed by the Tsuna factory on Stellar.",
};

export default function CreatePage() {
  const creator = publisherAccount();
  const ready = creator !== null && serverKey("LEASH_CREATE_FEE_SECRET") !== null;
  return (
    <>
      <PageLayout>
        <PageHeader title="Publish an agent" description="Choose a strategy, then the rules it can never break." />
        <CreateFlow presets={presetCatalog()} creator={ready ? creator : null} />
      </PageLayout>
    </>
  );
}
