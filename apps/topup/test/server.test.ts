import { describe, expect, test } from "bun:test";
import { buildServer } from "../src/server";
import type { TopUp } from "../src/topup";

function fake(healthy: boolean) {
  const released: string[] = [];
  const topup = {
    healthy: () => healthy,
    view: () => ({ role: "leader", treasury: { balance: "1" } }),
    release: async (name: string) => {
      released.push(name);
      return name === "oracle" ? "released" : "unknown-target";
    },
  } as unknown as TopUp;
  return { topup, released };
}

const TOKEN = "t".repeat(32);

describe("server", () => {
  test("/live always answers; /health follows the service", async () => {
    const down = buildServer(fake(false).topup, { chainId: 10143, store: "file" });
    expect((await down.request("/live")).status).toBe(200);
    const res = await down.request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, chainId: 10143, store: "file", role: "leader" });
    expect((await buildServer(fake(true).topup, { chainId: 10143, store: "file" }).request("/health")).status).toBe(200);
  });

  test("release needs ADMIN_TOKEN configured and presented", async () => {
    const off = fake(true);
    expect((await buildServer(off.topup, { chainId: 1, store: "file" }).request("/targets/oracle/release", { method: "POST" })).status).toBe(404);
    const on = fake(true);
    const app = buildServer(on.topup, { chainId: 1, store: "file", adminToken: TOKEN });
    const post = (name: string, token?: string) =>
      app.request(`/targets/${name}/release`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await post("oracle")).status).toBe(401);
    expect((await post("oracle", "wrong")).status).toBe(401);
    expect(on.released).toEqual([]);
    expect((await post("oracle", TOKEN)).status).toBe(200);
    expect((await post("nobody", TOKEN)).status).toBe(404);
    expect(on.released).toEqual(["oracle", "nobody"]);
  });
});
