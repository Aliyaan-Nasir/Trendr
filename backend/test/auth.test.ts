import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ContractFunctionZeroDataError } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { issueSession } from "../src/api/admin-auth";
import { clientIp, rateKey, rateLimit } from "../src/api/rate-limit";
import { AccountKeys, ChainUnavailableError, issueUserToken, readUserToken, signInMessage } from "../src/api/user-auth";

/** Unit checks for the client IP every rate limit uses, and for which keys may act for an account. */

const SECRET = "s".repeat(64);
const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000d44");
const session = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000e55");
const T = 1_800_000_000;

describe("client IP", () => {
  const app = new Hono();
  app.get("/ip", (c) => c.text(clientIp(c, Number(c.req.query("hops")))));
  /** Bun.serve passes the server as the env; Hono reads the socket peer from it. */
  const socket = (address: string) => ({ requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 40_000 }) });
  const ip = async (hops: number, forwardedFor: string | string[] | null, peer: string | null = "192.0.2.10") => {
    const headers = new Headers();
    for (const v of forwardedFor === null ? [] : Array.isArray(forwardedFor) ? forwardedFor : [forwardedFor]) headers.append("x-forwarded-for", v);
    return (await app.request(`/ip?hops=${hops}`, { headers }, peer ? socket(peer) : undefined)).text();
  };

  test("with no trusted proxy, the socket's peer counts and X-Forwarded-For is ignored", async () => {
    expect(await ip(0, "203.0.113.1")).toBe("192.0.2.10");
    expect(await ip(0, null, null)).toBe("unknown");
  });

  test("behind n proxies, the entry n from the right counts; the client's own entries do not", async () => {
    expect(await ip(1, "6.6.6.6, 198.51.100.7")).toBe("198.51.100.7");
    expect(await ip(1, ["6.6.6.6", "198.51.100.7"])).toBe("198.51.100.7");
    expect(await ip(2, "6.6.6.6, 198.51.100.7, 10.0.0.1")).toBe("198.51.100.7");
    // Fewer entries than proxies: the request did not come through them, so its socket counts.
    expect(await ip(2, "198.51.100.7")).toBe("192.0.2.10");
    expect(await ip(1, null)).toBe("192.0.2.10");
  });

  test("IPv6 clients count per /64, and IPv4-mapped addresses as IPv4", async () => {
    expect(rateKey("2001:db8:1:2:3:4:5:6")).toBe("2001:0db8:0001:0002::/64");
    expect(rateKey("2001:DB8:1:2::ffff")).toBe("2001:0db8:0001:0002::/64");
    expect(rateKey("2001:db8:1:3::1")).toBe("2001:0db8:0001:0003::/64");
    expect(rateKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
    expect(rateKey("64:ff9b::198.51.100.7")).toBe("0064:ff9b:0000:0000::/64");
    expect(rateKey("::")).toBe("0000:0000:0000:0000::/64");
    expect(await ip(0, null, "2001:db8:1:2::77")).toBe("2001:0db8:0001:0002::/64");
  });

  test("limits key on anything a route chooses, such as the signed-in account", async () => {
    const limited = new Hono<{ Variables: { user: string } }>();
    limited.use("*", async (c, next) => {
      c.set("user", c.req.header("x-user") ?? "");
      await next();
    });
    limited.get("/", rateLimit<{ Variables: { user: string } }>(2, 60_000, (c) => c.get("user"), () => 0), (c) => c.text("ok"));
    const hit = async (user: string) => (await limited.request("/", { headers: { "x-user": user } })).status;
    expect([await hit("a"), await hit("a"), await hit("a"), await hit("b")]).toEqual([200, 200, 429, 200]);
  });
});

describe("user tokens", () => {
  test("carry the signing key, and tokens without one are not user tokens", () => {
    const token = issueUserToken(SECRET, account.address, session.address, T + 60);
    expect(readUserToken(SECRET, token, T)).toEqual({ account: account.address.toLowerCase(), signer: session.address.toLowerCase(), expiresAt: T + 60 });
    expect(readUserToken(SECRET, token, T + 60)).toBeNull();
    expect(readUserToken("t".repeat(64), token, T)).toBeNull();
    expect(readUserToken(SECRET, issueSession(SECRET, account.address, T + 60, "user"), T)).toBeNull();
    expect(readUserToken(SECRET, issueSession(SECRET, account.address, T + 60, "admin", session.address), T)).toBeNull();
  });
});

describe("account keys", () => {
  type Read = { functionName: string; args: readonly unknown[] };
  const keys = (read: (r: Read) => unknown, isGrantKey = async () => false, now = () => T * 1000) => {
    const reads: string[] = [];
    const client = {
      readContract: async (r: Read) => {
        reads.push(r.functionName);
        return read(r);
      },
    };
    const target = "0x00000000000000000000000000000000000000aa" as const;
    return { reads, keys: new AccountKeys(client as never, [{ target, selector: "0x12345678" }], isGrantKey, 30_000, now) };
  };
  const active = { active: true, validUntil: BigInt(T + 3600), dailyLimit: 0n, day: 0, spentToday: 0n, nonce: 0n };
  const sign = async (signer = session) => {
    const body = { account: account.address, signer: signer.address, issuedAt: T };
    return { ...body, signature: await signer.signMessage({ message: signInMessage(body.account, body.signer, body.issuedAt) }) };
  };

  test("the account's own key needs no chain read", async () => {
    const k = keys(() => {
      throw new Error("no read expected");
    });
    expect(await k.keys.verify(await sign(account), T)).toMatchObject({ signer: account.address, expiresAt: T + 12 * 3600 });
    expect(await k.keys.stillActive(account.address, account.address)).toBe(true);
    expect(k.reads).toEqual([]);
  });

  test("a grant key is refused before the chain is asked", async () => {
    const k = keys(() => active, async () => true);
    await expect(k.keys.verify(await sign(), T)).rejects.toThrow("Autopilot's session key cannot sign in");
    expect(k.reads).toEqual([]);
  });

  test("a trading session signs in until its validUntil; an account that answers no is not active", async () => {
    const k = keys((r) => (r.functionName === "sessionOf" ? active : true));
    expect(await k.keys.verify(await sign(), T)).toMatchObject({ signer: session.address, expiresAt: T + 3600 });
    const gone = keys(() => {
      throw new ContractFunctionZeroDataError({ functionName: "sessionOf" });
    });
    expect(await gone.keys.stillActive(account.address, session.address)).toBe(false);
    await expect(gone.keys.verify(await sign(), T)).rejects.toThrow("not an active session");
  });

  test("an RPC failure is ChainUnavailableError, never a refusal, and is not cached", async () => {
    let down = true;
    const k = keys(() => {
      if (down) throw new Error("fetch failed");
      return active;
    });
    await expect(k.keys.stillActive(account.address, session.address)).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(k.keys.verify(await sign(), T)).rejects.toBeInstanceOf(ChainUnavailableError);
    down = false;
    expect(await k.keys.stillActive(account.address, session.address)).toBe(true);
  });

  test("answers are cached for 30 seconds, and a session past validUntil is not active", async () => {
    let t = T * 1000;
    let s = active;
    const k = keys(() => s, async () => false, () => t);
    expect(await k.keys.stillActive(account.address, session.address)).toBe(true);
    s = { ...active, active: false };
    t += 29_000;
    expect(await k.keys.stillActive(account.address, session.address)).toBe(true);
    t += 1_000;
    expect(await k.keys.stillActive(account.address, session.address)).toBe(false);
    expect(k.reads).toEqual(["sessionOf", "sessionOf"]);
    // Still flagged active on chain but expired.
    s = active;
    t = (T + 3600) * 1000;
    expect(await k.keys.stillActive(account.address, session.address)).toBe(false);
  });
});
