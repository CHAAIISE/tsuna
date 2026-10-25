import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Testnet suites submit from shared burner accounts: run files one at a time.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
