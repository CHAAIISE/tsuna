import { expect, test } from "@playwright/test";

test("the landing leads to the live agent catalogue", async ({ page }) => {
  await test.step("01 · understand the promise and explore agents", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const explore = page.locator("[data-primary]:visible");
    await expect(explore).toHaveCount(1);
    await expect(explore).toHaveAttribute("href", "/agents");
    await explore.click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole("region", { name: "Featured agents" }).getByTestId("agent-row")).toHaveCount(3);
  });
});
