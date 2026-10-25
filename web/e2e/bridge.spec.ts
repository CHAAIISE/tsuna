import { expect, test } from "@playwright/test";

const statusLabels = { pending: "Not started", running: "In progress", done: "Done", failed: "Failed" } as const;
const stepIds = ["burn", "attestation", "mint", "swap", "deposit"] as const;

interface BridgeStatus {
  job: { status: string; steps: { id: (typeof stepIds)[number]; status: keyof typeof statusLabels }[] } | null;
  bridge: { ready: boolean };
}

test("the bridge tracker renders the status served by the API", async ({ page, request }) => {
  const response = await request.get("/api/bridge");
  expect(response.ok()).toBe(true);
  const status = await response.json() as BridgeStatus;

  await page.goto("/bridge");
  await expect(page.getByRole("heading", { name: "Deposit from Ethereum" })).toBeVisible();
  const tracker = page.getByTestId("bridge-tracker");
  await expect(tracker).toHaveAttribute("data-job-status", status.job?.status ?? "none");

  // A running job may advance between the two reads; finished or absent jobs are stable.
  if (status.job?.status !== "running") {
    for (const id of stepIds) {
      const expected = status.job?.steps.find(step => step.id === id)?.status ?? "pending";
      await expect(page.getByTestId(`bridge-step-${id}`)).toHaveAttribute("data-status", expected);
      await expect(page.getByTestId(`bridge-step-${id}-status`)).toHaveText(statusLabels[expected]);
    }
  }
  const primary = page.locator("[data-primary]");
  await expect(primary).toHaveCount(1);
  if (status.job?.status === "done") await expect(primary).toHaveAttribute("href", "/agents");
});
