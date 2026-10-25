import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const screens = [
  { id: "landing", path: "/", ready: "h1" },
  { id: "agents", path: "/agents", ready: '[data-testid="agents-count"]' },
  { id: "onboarding", path: "/onboarding", ready: '[data-testid="create-passkey"]' },
  { id: "vault", path: "/agents/prudent", ready: '[data-testid="deposit-amount"]' },
  { id: "crash", path: "/agents/leverage", ready: '[data-testid="deposit-amount"]' },
  { id: "liquidity", path: "/agents/liquidity", ready: '[data-testid="deposit-amount"]' },
  { id: "attack", path: "/agents/prudent/attack", ready: '[data-testid="attack-injection"]' },
  { id: "fleet", path: "/fleet", ready: '[data-testid="current-build"]' },
  { id: "create", path: "/create", ready: '[data-testid="strategy-yield"]' },
  { id: "bridge", path: "/bridge", ready: '[data-testid="bridge-tracker"]' },
  { id: "portfolio", path: "/portfolio", ready: 'main [data-primary]' },
];

async function guidedScreen(page: Page) {
  await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
  await expect(page.getByTestId("onboarding-steps")).toHaveCount(1);
  await expect(page.getByTestId("onboarding-steps")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`a new visitor has one next action and onboarding guidance at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize(viewport);
    const screenshots = resolve(process.env.LEASH_SCREENSHOT_DIR ?? test.info().outputPath("screenshots"));
    await mkdir(screenshots, { recursive: true });
    for (const screen of screens) {
      await test.step(screen.id, async () => {
        await page.goto(screen.path);
        await expect(page.locator(screen.ready).first()).toBeVisible();
        if (screen.id === "agents") await expect(page.getByTestId("agents-count")).not.toHaveText("—");
        await guidedScreen(page);
        await expect(page.getByTestId("onboarding-steps").locator('[aria-current="step"]')).toContainText("Create your passkey");
        await page.screenshot({ path: resolve(screenshots, `ux-${screen.id}-apres-${viewport.width === 1440 ? "desktop" : "mobile"}.png`), fullPage: true });
      });
    }

    await test.step("creator reviews rules without losing its next action", async () => {
      await page.goto("/create");
      await page.locator("[data-primary]:visible").click();
      await expect(page.getByRole("heading", { name: "Leash rules", exact: true })).toBeVisible();
      await guidedScreen(page);
      await page.locator("[data-primary]:visible").click();
      await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
      await guidedScreen(page);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await guidedScreen(page);
    });

    await test.step("attack rules retain a single recovery action", async () => {
      await page.goto("/agents/prudent/attack");
      await page.getByRole("tab", { name: "Leash rules", exact: true }).click();
      await guidedScreen(page);
    });
  });
}

test("a newly created account is guided to funds instead of an unusable deposit", async ({ page, context }) => {
  test.setTimeout(300_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto("/");
  await page.locator("[data-primary]").click();
  await expect(page).toHaveURL(/\/agents$/);
  await page.locator("[data-primary]").click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByTestId("create-passkey").click();
  await expect(page.getByTestId("account-ready")).toBeVisible();
  await expect(page.getByTestId("usdc-balance")).toContainText("0.00");
  await guidedScreen(page);
  await expect(page.getByTestId("onboarding-steps").locator('[aria-current="step"]')).toContainText("Get test USDC");

  for (const path of ["/agents", "/agents/prudent", "/portfolio"]) {
    await page.goto(path);
    await expect(page.getByTestId("onboarding-steps").locator('[aria-current="step"]')).toContainText("Get test USDC");
    await guidedScreen(page);
    if (path !== "/portfolio") await expect(page.locator("[data-primary]")).toHaveAttribute("href", "/onboarding");
  }
  await page.goto("/agents/prudent#withdraw");
  await expect(page.getByTestId("withdraw-submit")).toBeDisabled();
  await guidedScreen(page);
  await expect(page.getByRole("tablist", { name: "Action", exact: true }).getByRole("tab", { selected: true })).toHaveAccessibleName(/withdraw/i);
});
