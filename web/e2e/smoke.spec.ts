import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { formatUsdc } from "../lib/stellar/format";

const contractAddress = z.string().regex(/^C[A-Z2-7]{55}$/);
const nav = z.string().regex(/^\d+$/);
const navError = z.object({
  contract: z.string(),
  code: z.number(),
  name: z.string(),
  message: z.string(),
});
const pricedVault = z.object({
  address: contractAddress,
  nav,
  navError: z.null(),
});
const agentsResponse = z.object({
  rows: z.array(z.object({
    featured: z.boolean(),
    id: z.string(),
    address: contractAddress,
    nav: nav.nullable(),
    navError: navError.nullable(),
  })),
  totalNav: nav,
});

async function visit(page: Page, path: string, ready: string) {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  await expect(page.locator(ready).first()).toBeVisible();
  await expect(page).toHaveTitle(/Leash/);
}

async function explorerLinks(page: Page) {
  const links = page.locator('a[href*="stellar.expert"]:visible');
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("href", /^https:\/\/stellar\.expert\/explorer\/testnet\/(?:contract\/[C][A-Z2-7]{55}|account\/[GC][A-Z2-7]{55}|tx\/[a-fA-F0-9]{64})$/);
  }
}

test("@smoke read-only demo journey with live testnet data", async ({ page, context }) => {
  test.setTimeout(600_000);
  const mutations: string[] = [];
  const errors: string[] = [];
  // Fail closed: a regression must not send a mutation even before the assertion fails.
  await context.route("**/*", async route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      mutations.push(`${request.method()} ${request.url()}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (new URL(response.url()).pathname.startsWith("/api/") && !response.ok()) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("requestfailed", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.failure()?.errorText !== "net::ERR_ABORTED") {
      errors.push(`${request.failure()?.errorText} ${request.url()}`);
    }
  });

  await test.step("landing has project metadata and working project icons", async () => {
    await visit(page, "/", "h1");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Stellar/);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", /^#[a-fA-F0-9]{6}$/);
    for (const rel of ["icon", "apple-touch-icon"]) {
      const icon = page.locator(`link[rel="${rel}"]`).first();
      await expect(icon).toHaveAttribute("href", rel === "icon" ? /\/icon\.svg(?:\?|$)/ : /\/apple-icon\.png(?:\?|$)/);
      const href = await icon.getAttribute("href");
      if (!href) throw new Error(`Missing ${rel} URL`);
      const response = await page.request.get(new URL(href, page.url()).href);
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-type"]).toContain(rel === "icon" ? "image/svg+xml" : "image/png");
      if (rel === "icon") expect(await response.text()).toContain("<svg");
    }
  });

  await test.step("all three demo vaults have live priced data", async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/vaults" && response.request().method() === "GET");
    await visit(page, "/agents", '[data-testid="agents-count"]');
    const data = agentsResponse.parse(await (await response).json());
    const demo = data.rows.filter(row => row.featured);
    expect(demo.map(row => row.id).sort()).toEqual(["leverage", "liquidity", "prudent"]);
    await expect(page.getByRole("region", { name: "Featured agents" }).getByTestId("agent-row")).toHaveCount(3);
    await expect(page.getByTestId("agents-count")).toHaveText(String(data.rows.length));
    expect(BigInt(data.totalNav)).toBeGreaterThan(0n);
    await expect(page.getByTestId("total-in-vaults")).toHaveText(`${formatUsdc(data.totalNav)} USDC`);
    for (const vault of demo) {
      const priced = pricedVault.parse(vault);
      const row = page.locator(`[data-testid="agent-row"][data-vault="${vault.address}"]`);
      await expect(row.getByTestId("agent-tvl")).toHaveText(`${formatUsdc(priced.nav)} USDC`);
      await expect(row.locator(`a[href="/agents/${vault.id}"]`).first()).toBeVisible();
    }
  });

  for (const id of ["prudent", "leverage", "liquidity"]) {
    await test.step(`${id} vault loads its real contract and NAV`, async () => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/vaults/${id}` && response.request().method() === "GET");
      await visit(page, `/agents/${id}`, '[data-testid="deposit-amount"]');
      const data = pricedVault.parse(await (await response).json());
      await expect(page.getByTestId("kpi-tvl")).toHaveText(formatUsdc(data.nav));
      await expect(page.locator(`a[href="https://stellar.expert/explorer/testnet/contract/${data.address}"]`)).toBeVisible();
      await expect(page.getByTestId("agent-journal")).toBeVisible();
      await explorerLinks(page);
    });
  }

  for (const screen of [
    { path: "/agents/prudent/attack", ready: '[data-testid="attack-injection"]' },
    { path: "/onboarding", ready: '[data-testid="create-passkey"]' },
    { path: "/portfolio", ready: 'main [data-primary][href="/onboarding"]' },
    { path: "/fleet", ready: '[data-testid="current-build"]' },
    { path: "/create", ready: '[data-testid="strategy-yield"]' },
    { path: "/bridge", ready: '[data-testid="bridge-tracker"]' },
  ]) {
    await test.step(`read ${screen.path} without starting an operation`, async () => {
      await visit(page, screen.path, screen.ready);
      if (screen.path === "/fleet") {
        await expect(page.getByTestId("fleet-uniform")).toHaveText(/\d+ of [1-9]\d*/);
        expect(await page.getByTestId("fleet-vault").count()).toBeGreaterThan(0);
        await expect(page.getByTestId("current-build")).not.toHaveText("Not published");
      }
      if (screen.path === "/bridge") await expect(page.locator('[data-testid^="bridge-step-"][data-status]')).toHaveCount(5);
      await explorerLinks(page);
      expect(errors, `Errors on ${screen.path}`).toEqual([]);
      expect(mutations, "No mutation request may leave the browser").toEqual([]);
    });
  }

  if (process.env.BASE_URL) {
    await test.step("production does not expose the design playground", async () => {
      const response = await page.goto("/design");
      expect(response?.status()).toBe(404);
    });
  }
  expect(errors).toEqual([]);
  expect(mutations).toEqual([]);
});
