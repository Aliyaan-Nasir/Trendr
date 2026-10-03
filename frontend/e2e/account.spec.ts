import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * Mera passkey accounts end to end, with Chrome's virtual authenticator (PRF enabled) standing in
 * for the user's passkey: one-prompt onboarding with a gas-free activation, the stateless test
 * (storage wiped, identity rebuilt from the passkey), and a fresh device with the passkey synced.
 */

const RPC = "http://127.0.0.1:8645";
const deployment = () => JSON.parse(readFileSync(join(__dirname, ".state", "deployment.json"), "utf8")) as { passkeyAccount: string };

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: string }).result;
}

async function addAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  return { cdp, authenticatorId };
}

async function openSheet(page: Page) {
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await expect(page.getByTestId("account-sheet")).toBeVisible();
}

test("one-prompt onboarding, the stateless test and a fresh device", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  const { cdp, authenticatorId } = await addAuthenticator(context, page);

  // Onboarding: one passkey ceremony, then the relayer activates the account gas-free.
  const started = Date.now();
  await openSheet(page);
  await page.getByTestId("create-account").click();
  const addressButton = page.getByTestId("account-address");
  await expect(addressButton).toBeVisible({ timeout: 60_000 });
  const address = (await addressButton.getAttribute("data-address"))!;
  console.log(`account ${address} active in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials).toHaveLength(1);

  // On chain: an EIP-7702 delegation to PasskeyAccount, and the account holds no MON.
  expect(await rpc("eth_getCode", [address, "latest"])).toBe(`0xef0100${deployment().passkeyAccount.slice(2).toLowerCase()}`);
  expect(BigInt(await rpc("eth_getBalance", [address, "latest"]))).toBe(0n);

  // The stateless test: wipe every bit of storage, reload, sign in, same account.
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("trendr-account");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await openSheet(page);
  await expect(page.getByTestId("create-account")).toBeVisible();
  await page.getByTestId("sign-in").click();
  await expect(page.getByTestId("account-address")).toHaveAttribute("data-address", address);
  // Reloading now restores the session from this device without a prompt.
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(`${address.slice(-4)}$`, "i") }).first()).toBeVisible();

  // A fresh device: every kind of site data cleared by the browser itself and a brand-new page,
  // with the passkey still on the authenticator as a synced passkey would be. (A second browser
  // profile cannot be used: virtual authenticators do not export a credential's PRF secret.)
  // Virtual authenticators belong to the page they were added to, so the same page leaves for a
  // blank document and comes back as a brand-new document.
  await page.goto("about:blank");
  await cdp.send("Storage.clearDataForOrigin", { origin: "http://localhost:3100", storageTypes: "all" });
  const freshPage = page;
  await freshPage.goto("/");
  await openSheet(freshPage);
  await expect(freshPage.getByTestId("create-account")).toBeVisible();
  await freshPage.getByTestId("sign-in").click();
  await expect(freshPage.getByTestId("account-address")).toHaveAttribute("data-address", address);

  await context.close();
});
