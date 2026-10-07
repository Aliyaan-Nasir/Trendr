import { expect, type Page } from "@playwright/test";
import { adminAccount, installWallet, type WalletProbe } from "./wallet";

export const SESSION_KEY = "trendr-admin:session";

/** Connects the injected admin wallet and signs in through the UI, as a reviewer would. */
export async function signInAsAdmin(page: Page, path = "/candidates"): Promise<WalletProbe> {
  const probe = await installWallet(page, adminAccount());
  await page.goto(path);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await signInWithConnectedWallet(page);
  await expect(page.getByTestId("session-address")).toBeVisible();
  return probe;
}

export const storedSession = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);

/** Clicks "Sign in with this wallet"; callers assert the outcome. */
export async function signInWithConnectedWallet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign in with this wallet" }).click();
}
