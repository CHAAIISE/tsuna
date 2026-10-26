import { expect, test } from "@playwright/test";

test("publishing an agent deploys a factory vault with its rules", async ({ page, request }) => {
  test.setTimeout(240_000);
  await test.step("11 · publish preset rules and discover the new agent", async () => {
    await page.goto("/create");
    await expect(page.getByRole("heading", { name: "Publish an agent" })).toBeVisible();
    await expect(page.locator("[data-primary]:visible")).toHaveCount(1);

    await page.getByTestId("strategy-yield").click();
    await page.locator("[data-primary]:visible").click();

    await expect(page.getByRole("heading", { name: "Tsuna rules" })).toBeVisible();
    await page.getByText("0.25 %").click();
    await page.getByText("60 % per position protocol").click();
    await page.getByTestId("risk-off-option").click();
    await page.locator("[data-primary]:visible").click();

    await expect(page.getByText("Yes: may only unwind, even while paused")).toBeVisible();
    await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
    await page.getByRole("button", { name: "Publish", exact: true }).click();

    const published = page.getByTestId("create-published");
    await expect(published).toBeVisible({ timeout: 180_000 });
    const vault = await published.getAttribute("data-vault");
    expect(vault).toMatch(/^C[A-Z2-7]{55}$/);
    console.log(`CREATED_VAULT ${vault}`);
    for (const href of await published.locator('a[href*="/tx/"]').evaluateAll(links => links.map(link => link.getAttribute("href")))) {
      console.log(`TX ${href?.split("/tx/")[1]}`);
    }

    const response = await request.get("/api/fleet?fleet=demo");
    expect(response.ok()).toBe(true);
    const { state } = await response.json() as {
      state: { current: { hash: string }; vaults: { address: string; wasmHash: string; policy: { registered: boolean; exposureCaps: number | null; roles: string[] | null } }[] };
    };
    const listed = state.vaults.find(item => item.address === vault);
    expect(listed?.wasmHash).toBe(state.current.hash);
    expect(listed?.policy).toEqual({ registered: true, exposureCaps: 2, roles: ["riskoff"] });

    await page.getByRole("link", { name: "See it in the fleet" }).click();
    await expect(page.locator(`[data-testid="fleet-vault"][data-address="${vault}"]`)).toBeVisible();
    await page.goto("/agents");
    await expect(page.locator(`[data-testid="agent-row"][data-vault="${vault}"]`)).toBeVisible();
  });
});
