import { expect, test, type APIRequestContext } from "@playwright/test";

interface FleetState {
  timelockSecs: number;
  current: { hash: string } | null;
  pending: { build: { hash: string }; eta: number } | null;
  vaults: { address: string; name: string; wasmHash: string | null; executableRef: { owner: string; tag: string } | null }[];
}

async function fleetState(request: APIRequestContext, fleet: string): Promise<FleetState> {
  const response = await request.get(`/api/fleet?fleet=${fleet}`);
  expect(response.ok()).toBe(true);
  return (await response.json() as { state: FleetState }).state;
}

test("the demo fleet shows every factory vault on the factory's executable", async ({ page, request }) => {
  const state = await fleetState(request, "demo");
  expect(state.current).not.toBeNull();
  expect(state.vaults.length).toBeGreaterThanOrEqual(3);

  await page.goto("/fleet");
  await expect(page.getByRole("heading", { name: "Fleet", exact: true })).toBeVisible();
  const rows = page.getByTestId("fleet-vault");
  await expect(rows).toHaveCount(state.vaults.length);
  for (const name of ["Prudent", "Leverage", "Liquidity"]) {
    await expect(rows.filter({ hasText: name })).toHaveCount(1);
  }
  for (const vault of state.vaults) {
    const row = page.locator(`[data-testid="fleet-vault"][data-address="${vault.address}"]`);
    await expect(row.getByTestId("vault-wasm")).toHaveAttribute("data-hash", vault.wasmHash ?? "");
    expect(vault.executableRef?.tag).toBe("vault-v1");
  }
  await expect(page.locator("[data-primary]:visible")).toHaveCount(1);
});

test("a policy written as v1 reads as v2 with its new fields not set", async ({ page }) => {
  await page.goto("/fleet?fleet=test");
  const v1 = page.getByTestId("fleet-vault").filter({ hasText: "Test vault A" });
  await expect(v1.getByTestId("vault-exposure-caps")).toContainText("not set");
  await expect(v1.getByTestId("vault-roles")).toContainText("not set");
  const v2 = page.getByTestId("fleet-vault").filter({ hasText: "Test vault B" });
  await expect(v2.getByTestId("vault-roles")).toContainText("riskoff");
});

test("one apply moves every vault of the test fleet to the proposed build", async ({ page, request }) => {
  const before = await fleetState(request, "test");
  test.setTimeout((before.timelockSecs + 240) * 1_000);
  await page.goto("/fleet?fleet=test");

  let target: string;
  if (before.pending) {
    // A previous run proposed and stopped before applying: finish that patch.
    target = before.pending.build.hash;
  } else {
    target = await page.locator('input[name="build"]:checked').inputValue();
    expect(target).not.toBe(before.current?.hash);
    await page.getByRole("button", { name: "Propose patch" }).click();
    const proposed = page.getByTestId("propose-tx");
    await expect(proposed).toBeVisible();
    test.info().annotations.push({ type: "propose_ref", description: await proposed.getAttribute("data-hash") ?? "" });
  }

  await expect(page.getByTestId("pending-patch")).toHaveAttribute("data-hash", target);
  await expect(page.getByTestId("timelock-countdown")).toHaveText(/^\d{2}:\d{2}$|^Ready$/);
  const apply = page.getByRole("button", { name: "Apply to all vaults" });
  await expect(apply).toBeDisabled();
  await expect(apply).toBeEnabled({ timeout: (before.timelockSecs + 60) * 1_000 });
  await apply.click();
  const applied = page.getByTestId("apply-tx");
  await expect(applied).toBeVisible();
  test.info().annotations.push({ type: "apply_ref", description: await applied.getAttribute("data-hash") ?? "" });

  const cells = page.getByTestId("vault-wasm");
  await expect(cells).toHaveCount(before.vaults.length);
  for (const cell of await cells.all()) await expect(cell).toHaveAttribute("data-hash", target);
  await expect(page.getByTestId("fleet-proof")).toBeVisible();

  const after = await fleetState(request, "test");
  expect(after.current?.hash).toBe(target);
  expect(after.pending).toBeNull();
  expect(after.vaults.every(vault => vault.wasmHash === target)).toBe(true);
  for (const note of test.info().annotations) console.log(`${note.type.toUpperCase()} ${note.description}`);
});
