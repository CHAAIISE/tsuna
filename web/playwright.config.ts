import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "3100";
const externalBaseURL = process.env.BASE_URL;

export default defineConfig({
  testDir: "e2e",
  ...(externalBaseURL ? { testMatch: "smoke.spec.ts", grep: /@smoke/ } : {}),
  timeout: 300_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: externalBaseURL ?? `http://localhost:${port}`, trace: "retain-on-failure", serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(!externalBaseURL ? { webServer: { command: `pnpm dev --port ${port}`, url: `http://localhost:${port}`, reuseExistingServer: true, timeout: 180_000 } } : {}),
});
