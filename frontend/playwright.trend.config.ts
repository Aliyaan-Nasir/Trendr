import { defineConfig, devices } from "@playwright/test";

/**
 * The trend page end to end on live Monad Testnet: a running app (default http://localhost:3000)
 * wired to the live backend, relayer, keeper, market maker and oracle. Real transactions, test
 * funds only. E2E_FUNDER_PRIVATE_KEY (a Testnet wallet holding AUSD) enables the Perpl step.
 * Run it against a production build: a dev server reloads the page whenever a file changes.
 *
 *   NEXT_DIST_DIR=.next-e2e npm run build && NEXT_DIST_DIR=.next-e2e npx next start -p 3000
 *   E2E_FUNDER_PRIVATE_KEY=... npx playwright test -c playwright.trend.config.ts
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /trend\.testnet\.spec\.ts$/,
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "e2e-results/trend",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // A disabled button never times out on its own; fail fast with the step that stuck.
    actionTimeout: 90_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
  },
});
