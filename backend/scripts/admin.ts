/**
 * Calls an admin endpoint signed with ADMIN_PRIVATE_KEY, the way the admin UI signs with a wallet.
 *   ADMIN_PRIVATE_KEY=0x... bun scripts/admin.ts GET '/v1/admin/candidates?status=pending'
 *   ADMIN_PRIVATE_KEY=0x... bun scripts/admin.ts POST /v1/admin/candidates/3/decision '{"decision":"approve"}'
 */
import { privateKeyToAccount } from "viem/accounts";
import { adminMessage } from "../src/api/admin-auth";

const [method = "GET", path = "/v1/admin/candidates", body = ""] = process.argv.slice(2);
const key = process.env.ADMIN_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("ADMIN_PRIVATE_KEY is required");
const base = process.env.BACKEND_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const account = privateKeyToAccount(key);
const ts = Math.floor(Date.now() / 1000);
const nonce = crypto.randomUUID().replace(/-/g, "");
const signature = await account.signMessage({ message: adminMessage(method, path, ts, nonce, body) });
const res = await fetch(`${base}${path}`, {
  method,
  headers: { "content-type": "application/json", "x-trendr-address": account.address, "x-trendr-timestamp": String(ts), "x-trendr-nonce": nonce, "x-trendr-signature": signature },
  ...(body ? { body } : {}),
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));
