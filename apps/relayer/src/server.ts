import { type Context, Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Logger } from "pino";
import { getAddress, type Hex } from "viem";
import { z } from "zod";
import type { Sent } from "@trendr/chain";
import { ipKey, pickClientIp } from "./client-ip";
import { RateLimiter } from "./rate-limit";
import { RelayError, type RelayerService } from "./service";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => getAddress(v));
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/).transform((v) => v as Hex);
const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as Hex);
const uint = z.string().regex(/^\d{1,78}$/).transform((v) => BigInt(v));

const call = z.object({ target: address, value: uint, data: hex });
const calls = z.array(call).min(1).max(8);
const session = z.object({
  key: address,
  validUntil: z.number().int().nonnegative(),
  dailyLimit: uint,
  permissions: z
    .array(
      z.object({
        target: address,
        selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/).transform((v) => v as Hex),
        recipientArg: z.number().int().min(0).max(255),
        guard: address,
      }),
    )
    .max(32),
});

const authorization = z.object({
  address,
  chainId: z.number().int().positive(),
  nonce: z.number().int().nonnegative(),
  r: word,
  s: word,
  yParity: z.union([z.literal(0), z.literal(1)]),
});

const activateBody = z.object({
  account: address,
  authorization,
  owner: z.object({ x: word, y: word }),
  session,
  deadline: uint,
  eoaSignature: hex,
  ticket: z.object({ expiresAt: z.number().int().positive(), signature: hex }).optional(),
});

const upgradeBody = z.object({ account: address, authorization, sessions: z.array(session).min(1).max(1), deadline: uint, eoaSignature: hex });

const sessionBody = z.object({ account: address, calls, sessionKey: address, deadline: uint, signature: hex });

const ownerBody = z.object({
  account: address,
  calls,
  deadline: uint,
  auth: z.object({
    authenticatorData: hex,
    clientDataJSON: z.string().min(1).max(2048),
    challengeIndex: uint,
    typeIndex: uint,
    r: word,
    s: word,
  }),
});

export interface ServerOptions {
  service: RelayerService;
  allowedOrigins: string[];
  log: Logger;
  /** Requests per account per minute (bursts up to this many). */
  perAccountPerMinute?: number;
  perIpPerMinute?: number;
  /** Activations one client address may request per hour. */
  activationsPerIpPerHour?: number;
  /**
   * Proxies in front of the relayer that append to X-Forwarded-For (Railway: 1). With 0 the client
   * is the socket peer and the header is ignored.
   */
  trustedProxyHops?: number;
  /** The sponsor keys' MON, for health: the relayer is down when no key can pay for a batch. */
  funds?: () => Promise<{ address: string; balanceWei: bigint }[]>;
  minBalanceWei?: bigint;
  /** Each RPC endpoint's requests, failures and health, by provider only (never a URL). */
  rpc?: () => Array<{ provider: string; requests: number; failures: number; healthy: boolean }>;
}

function serialize(sent: Sent) {
  return {
    hash: sent.hash,
    status: sent.status,
    blockNumber: sent.blockNumber.toString(),
    gasUsed: sent.gasUsed.toString(),
    gasLimit: sent.gasLimit.toString(),
  };
}

/** The socket peer's address from Bun's server, when the request came through one. */
function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // No Bun server behind the request (app.request in tests).
    return undefined;
  }
}

export function buildServer(o: ServerOptions) {
  const perAccount = new RateLimiter(o.perAccountPerMinute ?? 30, (o.perAccountPerMinute ?? 30) / 60);
  const perIp = new RateLimiter(o.perIpPerMinute ?? 120, (o.perIpPerMinute ?? 120) / 60);
  const activationsPerIp = new RateLimiter(o.activationsPerIpPerHour ?? 5, (o.activationsPerIpPerHour ?? 5) / 3_600);
  const hops = o.trustedProxyHops ?? 0;
  const app = new Hono<{ Variables: { ip: string } }>();

  app.use("*", cors({ origin: o.allowedOrigins, allowMethods: ["GET", "POST"], maxAge: 600 }));
  app.use("*", bodyLimit({ maxSize: 64 * 1024 }));
  let warnedProxy = false;
  app.use("/v1/*", async (c, next) => {
    const forwardedFor = c.req.header("x-forwarded-for");
    if (hops === 0 && forwardedFor && !warnedProxy) {
      warnedProxy = true;
      o.log.warn(
        "requests carry X-Forwarded-For but TRUSTED_PROXY_HOPS is 0: if a proxy is in front, every caller shares its address limits; set TRUSTED_PROXY_HOPS to the number of proxies (Railway: 1)",
      );
    }
    const ip = pickClientIp(forwardedFor, socketAddress(c), hops);
    const key = ip ? ipKey(ip) : "unknown";
    c.set("ip", key);
    if (!perIp.take(key)) return c.json({ error: "rate_limited", message: "too many requests" }, 429, { "Retry-After": String(perIp.retryAfter(key)) });
    await next();
  });

  // Liveness for the platform's deploy check: the process serves, whatever the sponsor keys hold.
  app.get("/live", (c) => c.json({ live: true }));

  let fundsCache: { at: number; value: Promise<{ address: string; balanceWei: bigint }[]> } | null = null;
  app.get("/v1/health", async (c) => {
    // Spend against the budgets. A spent budget is a throttle, not an outage, so it never turns
    // health red: a platform restarting the process on red health would reset the budgets.
    const budget = await o.service.usage().catch(() => null);
    const rpc = o.rpc ? { rpc: o.rpc() } : {};
    if (!o.funds) return c.json({ ok: true, budget, ...rpc });
    if (!fundsCache || Date.now() - fundsCache.at > 15_000) fundsCache = { at: Date.now(), value: o.funds() };
    const keys = await fundsCache.value.catch(() => null);
    if (!keys) return c.json({ ok: false, error: "could not read the sponsor balances", budget, ...rpc }, 503);
    const min = o.minBalanceWei ?? 0n;
    const ok = keys.some((k) => k.balanceWei >= min);
    if (!ok) o.log.warn({ keys: keys.map((k) => k.address) }, "every sponsor key is below the minimum MON balance");
    return c.json({ ok, keys: keys.map((k) => ({ address: k.address, mon: Number(k.balanceWei) / 1e18 })), budget, ...rpc }, ok ? 200 : 503);
  });

  app.get("/v1/accounts/:address", async (c) => {
    const parsed = address.safeParse(c.req.param("address"));
    if (!parsed.success) return c.json({ error: "bad_request", message: "invalid address" }, 400);
    const status = await o.service.status(parsed.data);
    return c.json(status);
  });

  const relay = <T extends { account: `0x${string}` }>(
    route: string,
    schema: z.ZodType<T>,
    handler: (input: T) => Promise<Sent>,
    perIpLimit?: RateLimiter,
  ) =>
    app.post(route, async (c) => {
      const body = schema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return c.json({ error: "bad_request", message: body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
      if (perIpLimit && !perIpLimit.take(c.get("ip"))) {
        return c.json({ error: "rate_limited", message: "too many requests of this kind from this address" }, 429, { "Retry-After": String(perIpLimit.retryAfter(c.get("ip"))) });
      }
      const accountKey = `${route}:${body.data.account}`;
      if (!perAccount.take(accountKey)) {
        return c.json({ error: "rate_limited", message: "too many requests for this account" }, 429, { "Retry-After": String(perAccount.retryAfter(accountKey)) });
      }
      const started = Date.now();
      try {
        const sent = await handler(body.data);
        o.log.info({ route, account: body.data.account, ip: c.get("ip"), hash: sent.hash, gasUsed: sent.gasUsed.toString(), gasLimit: sent.gasLimit.toString(), ms: Date.now() - started }, "relayed");
        return c.json(serialize(sent));
      } catch (e) {
        if (e instanceof RelayError) {
          o.log.warn({ route, account: body.data.account, ip: c.get("ip"), code: e.code, reason: e.message }, "rejected");
          const headers = e.retryAfter === undefined ? undefined : { "Retry-After": String(e.retryAfter) };
          return c.json({ error: e.code, message: e.message }, e.status, headers);
        }
        o.log.error({ route, account: body.data.account, err: e }, "relay failed");
        return c.json({ error: "internal", message: "relay failed" }, 500);
      }
    });

  relay("/v1/accounts/activate", activateBody, (i) => o.service.activate(i), activationsPerIp);
  relay("/v1/accounts/upgrade", upgradeBody, (i) => o.service.upgrade(i), activationsPerIp);
  relay("/v1/session/execute", sessionBody, (i) => o.service.executeSession(i));
  relay("/v1/owner/execute", ownerBody, (i) => o.service.executeOwner(i));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    o.log.error({ err }, "unhandled");
    return c.json({ error: "internal", message: "internal error" }, 500);
  });
  return app;
}
