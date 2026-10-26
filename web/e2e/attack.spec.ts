import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { rpc } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const scenarios = [
  ["injection", "CallNotAllowed"],
  ["blend-redirect", "DestinationNotVault"],
  ["defindex-shares", "NavDropped"],
  ["fake-token-route", "AssetNotAllowed"],
  ["stolen-key", "DestinationNotVault"],
] as const;

test("five attacks produce five real on-chain refusals with receipts", async ({ page }) => {
  test.setTimeout(900_000);
  await test.step("06 · submit five attacks and inspect each failed on-chain receipt", async () => {
    await page.goto("/agents/prudent/attack");
    await expect(page.getByRole("heading", { name: "Try to break it" })).toBeVisible();
    await expect(page.getByTestId("onboarding-steps")).toBeVisible();
    for (const [id, error] of scenarios) {
      await test.step(id, async () => {
        const card = page.getByTestId(`attack-${id}`);
        await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
        const previous = await card.getByTestId("attack-wall").count() ? await card.getByTestId("attack-wall").getAttribute("data-hash") : null;
        await card.getByRole("button").click();
        const wall = card.getByTestId("attack-wall");
        await expect(wall).toHaveAttribute("data-hash", /[0-9a-f]{64}/, { timeout: 360_000 });
        await expect.poll(() => wall.getAttribute("data-hash"), { timeout: 360_000 }).not.toBe(previous);
        await expect(wall).toHaveAttribute("data-blocked", "true");
        await expect(wall).toContainText(`Blocked on-chain · ${error}`);
        const hash = await wall.getAttribute("data-hash") ?? "";
        await expect(card.getByTestId("attack-tx")).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${hash}`);
        expect((await server.getTransaction(hash)).status).toBe("FAILED");
        console.log(`ATTACK_BLOCKED ${id} ${error} ${hash}`);
      });
    }
    await expect(page.locator('[data-testid="attack-wall"][data-blocked="true"]')).toHaveCount(5);
    const output = `${process.env.LEASH_SCREENSHOT_DIR ? resolve(process.env.LEASH_SCREENSHOT_DIR) : test.info().outputPath("screenshots")}/`;
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${output}attack-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}attack-mobile.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.getByRole("tab", { name: "Tsuna rules" }).click();
    await expect(page.getByRole("heading", { name: "Exposure caps", exact: true })).toBeVisible();
    await expect(page.getByText("Daily loss budget", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("protocol-watch")).toContainText("Pinned code matches");
    await page.screenshot({ path: `${output}attack-rules-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${output}attack-rules-desktop.png`, fullPage: true });
  });
});
