import { defineConfig, devices } from "@playwright/test";

/**
 * The portfolio and status specs, against the production build on port 3000 (see the trend config;
 * a dev server reloads mid-run) and the live Monad Testnet services it talks to (the backend on
 * :4000 and the relayer on :4100 allow that origin). Each portfolio run creates a fresh passkey account (the relayer pays its
 * activation and every trade in Testnet MON) and spends Testnet AUSD from the app's faucet, so
 * runs are independent of each other but not free: run the portfolio spec for final checks only.
 *
 *   npx playwright test -c playwright.portfolio.config.ts
 *   PORTFOLIO_SHOTS=/tmp/shots npx playwright test -c playwright.portfolio.config.ts   # plus screenshots
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /(portfolio|status)\.(live|unit)\.spec\.ts$/,
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  // Playwright empties its output folder at the start of a run: keep ours apart from other specs'.
  outputDir: "test-results/portfolio",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
