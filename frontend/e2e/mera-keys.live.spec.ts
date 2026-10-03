import type { Page } from "@playwright/test";
import { deviceNote } from "./content";
import { expect, LIVE, test, withIdentity } from "./live";
import { assertNoPlaintextKeys, type Dump, selfCheck } from "./storage-scan";

/**
 * One passkey, many keys: the passkey's PRF derives the trading account, its session key, the
 * caller identity, the vault key and the Perpl API key. A fresh device (every byte of site data
 * cleared) signs in with the same passkey and gets the same identity, the same vault key (an
 * earlier sealed note opens) and the same Perpl key. Nothing secret sits in browser storage in
 * plaintext: no 32-byte value anywhere in it is the private key of an address the app uses, and
 * the stored AES keys are non-extractable.
 */

test.skip(!LIVE, "live Testnet spec: run with playwright.live.config.ts");

/** Reads all of the origin's storage in the page, walking structured-cloned IndexedDB values. */
function dumpStorage(page: Page): Promise<Dump> {
  return page.evaluate(async () => {
    const out: Dump = { strings: [], bytes: [], keys: [], databases: [] };
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const walk = (v: unknown, at: string, depth = 0): void => {
      if (depth > 12 || v === null || v === undefined) return;
      if (typeof v === "string") out.strings.push(v);
      else if (v instanceof CryptoKey) out.keys.push({ at, type: v.type, algorithm: v.algorithm.name, extractable: v.extractable });
      else if (v instanceof ArrayBuffer) out.bytes.push(hex(new Uint8Array(v)));
      else if (ArrayBuffer.isView(v)) out.bytes.push(hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1));
      else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${at}.${k}`, depth + 1);
    };
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) walk([store.key(i), store.getItem(store.key(i)!)], "web-storage");
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      out.databases.push(info.name);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name!);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const name of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(name, "readonly").objectStore(name).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        walk(rows, `${info.name}/${name}`);
      }
      db.close();
    }
    return out;
  });
}

async function identityOf(page: Page) {
  await page.goto("/settings#identity");
  await withIdentity(page, page.getByTestId("profile-form"));
  const identity = (await page.getByTestId("identity-address").getAttribute("data-address"))!;
  const perpl = page.getByTestId("perpl-public-key");
  await expect(perpl).toHaveText(/^0x[0-9a-f]{64}$/);
  return { identity, perplKey: (await perpl.textContent())! };
}

test("one passkey rebuilds every key on a fresh device, and none is stored in plaintext", async ({ live, account }) => {
  const { page, cdp } = live;
  selfCheck();
  const first = await identityOf(page);
  expect(first.identity).toMatch(/^0x[0-9a-f]{40}$/);

  // A sealed note and a call, made on this device.
  const text = `Sealed on device one ${Date.now().toString(36)}`;
  await page.goto("/settings#notes");
  await withIdentity(page, page.getByTestId("note-new"));
  await page.getByTestId("note-new").click();
  await page.getByTestId("note-title").fill("Fresh device check");
  await page.getByTestId("note-body").fill(text);
  await page.getByTestId("note-save").click();
  await expect(page.getByTestId("note-card").filter({ hasText: text })).toBeVisible();

  await page.goto("/leaders");
  await page.getByTestId("make-call").click();
  await withIdentity(page, page.getByTestId("call-submit"));
  const trend = await page.getByTestId("call-trend").inputValue();
  const note = deviceNote();
  await page.getByTestId("call-note").fill(note);
  await page.getByTestId("call-submit").click();
  await expect(page.getByTestId("call-done")).toBeVisible();
  await page.keyboard.press("Escape");

  assertNoPlaintextKeys(await dumpStorage(page), "device one", [account, first.identity]);

  // A fresh device: all site data cleared by the browser, then the same passkey signs in. The
  // virtual authenticator belongs to this page, so the page leaves for a blank document first.
  await page.goto("about:blank");
  await cdp.send("Storage.clearDataForOrigin", { origin: live.origin, storageTypes: "all" });
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await expect(page.getByTestId("create-account")).toBeVisible();
  await page.getByTestId("sign-in").click();
  await expect(page.getByTestId("account-address")).toHaveAttribute("data-address", account);
  await expect(page.getByTestId("account-sheet").getByText("Synced")).toBeVisible();
  await page.keyboard.press("Escape");

  const second = await identityOf(page);
  console.log(`caller identity, device one: ${first.identity}`);
  console.log(`caller identity, fresh device: ${second.identity}`);
  console.log(`Perpl API key, device one: ${first.perplKey}; fresh device: ${second.perplKey}`);
  test.info().annotations.push({ type: "identity", description: `device one ${first.identity}, fresh device ${second.identity}` });
  expect(second.identity).toBe(first.identity);
  expect(second.perplKey).toBe(first.perplKey);

  // The earlier call is still this identity's.
  await page.goto(`/c/${second.identity}`);
  const call = page.getByTestId("call-row").filter({ hasText: note });
  await expect(call).toHaveAttribute("data-trend", trend);

  // The sealed note opens with the re-derived vault key.
  await page.goto("/settings#notes");
  await withIdentity(page, page.getByTestId("note-new"));
  await expect(page.getByTestId("note-card").filter({ hasText: text })).toBeVisible();

  assertNoPlaintextKeys(await dumpStorage(page), "fresh device", [account, second.identity]);
});
