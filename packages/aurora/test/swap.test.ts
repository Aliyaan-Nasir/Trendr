import { describe, expect, test } from "bun:test";
import {
  AuroraClient,
  AuroraHttpError,
  AuroraInputError,
  AuroraRateLimitError,
  AuroraResponseError,
  AuroraTimeoutError,
  depositQuoteRequest,
  hasDetails,
  isNotFound,
  MONAD_ASSETS,
  monadAsset,
  monadAssetDrift,
  minimumAmountFrom,
  quoteRequestSchema,
  withdrawalQuoteRequest,
} from "../src";
import { fixture, fromFixture, json, liveQuote, recordedSleep, scriptedFetch, statusLike } from "./helpers";

const KEY = "test-app-key-0000";
const account = "0x2222222222222222222222222222222222222222";

function client(script: Parameters<typeof scriptedFetch>[0], extra: Partial<ConstructorParameters<typeof AuroraClient>[0]> = {}) {
  const f = scriptedFetch(script);
  const s = recordedSleep();
  return { api: new AuroraClient({ apiKey: KEY, fetch: f.fetch, sleep: s.sleep, random: () => 0, ...extra }), ...f, waits: s.waits };
}

describe("tokens", () => {
  test("parses the recorded list and finds the three Monad assets", async () => {
    const { api, calls } = client([fromFixture("swap/tokens")]);
    const list = await api.tokens();
    expect(calls[0]!.url).toBe(`https://intents-api.aurora.dev/api/tokens/${KEY}`);
    expect(list.onChain("monad").map((t) => t.symbol).sort()).toEqual(["MON", "USDC", "USDT0"]);
    for (const symbol of ["USDC", "USDT0", "MON"] as const) expect(monadAsset(list, symbol).assetId).toBe(MONAD_ASSETS[symbol].assetId);
    expect(monadAssetDrift(list)).toEqual([]);
    expect(list.byContract("base", "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913")?.symbol).toBe("USDC");
    expect(list.byContract("eth", null)?.symbol).toBe("ETH");
  });

  test("is cached, shared between concurrent callers and refreshed on demand", async () => {
    let now = 0;
    const { api, calls } = client([fromFixture("swap/tokens"), fromFixture("swap/tokens")], { now: () => now });
    const [a, b] = await Promise.all([api.tokens(), api.tokens()]);
    expect(a).toBe(b);
    now = 60_000;
    expect(await api.tokens()).toBe(a);
    expect(calls).toHaveLength(1);
    now = 6 * 60_000;
    expect(await api.tokens()).not.toBe(a);
    expect(calls).toHaveLength(2);
  });
});

describe("quotes", () => {
  for (const name of ["exact-input", "exact-output", "flex-input", "solana"]) {
    test(`parses the recorded dry ${name} quote and sends the request unchanged`, async () => {
      const f = fixture(`swap/quote-dry-${name}`);
      const { api, calls } = client([json(f.status, f.body)]);
      const res = await api.quote(f.request);
      expect(calls[0]!.init.method).toBe("POST");
      expect(calls[0]!.body).toEqual(f.request);
      expect(BigInt(res.quote.minAmountOut)).toBeLessThanOrEqual(BigInt(res.quote.amountOut));
      expect(res.quote.depositAddress).toBeUndefined();
      expect(res.quoteRequest.refundType).toBe("ORIGIN_CHAIN");
    });
  }

  test("a live quote carries the deposit address and deadline", async () => {
    const live = liveQuote();
    const { api } = client([json(200, live.response)]);
    const res = await api.quote(live.request);
    expect(res.quote.depositAddress).toBe("0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426");
    expect(res.quote.timeWhenInactive).toBeDefined();
  });

  test("a live quote without a deposit address is rejected", async () => {
    const f = fixture("swap/quote-dry-exact-input");
    const { api } = client([json(200, f.body)]);
    expect(api.quote({ ...f.request, dry: false })).rejects.toBeInstanceOf(AuroraResponseError);
  });

  test("reports Aurora's minimum when the amount is too small", async () => {
    const f = fixture("swap/quote-error-amount-too-low");
    const { api } = client([json(f.status, f.body)]);
    const error = await api.quote(f.request).catch((e) => e);
    expect(error).toBeInstanceOf(AuroraHttpError);
    expect(error.status).toBe(400);
    expect(error.correlationId).toBe(f.body.correlationId);
    expect(minimumAmountFrom(error)).toBe(150_000n);
  });

  test("surfaces a refused refund address and an unknown key without leaking the key", async () => {
    const bad = fixture("swap/quote-error-invalid-refund");
    const unknown = fixture("swap/quote-error-unknown-key");
    const { api } = client([json(bad.status, bad.body), json(unknown.status, unknown.body)]);
    const e1 = await api.quote(bad.request).catch((e) => e);
    expect(e1.message).toContain("refundTo is not valid");
    const e2 = await api.quote(bad.request).catch((e) => e);
    expect(isNotFound(e2)).toBe(true);
    expect(e2.path).toBe("/api/quote/{apiKey}");
    for (const e of [e1, e2]) expect(`${e.message} ${e.path}`).not.toContain(KEY);
  });

  test("validates the request before sending it", async () => {
    const f = fixture("swap/quote-dry-exact-input");
    const { api, calls } = client([]);
    expect(api.quote({ ...f.request, slippageTolerance: 20_000 })).rejects.toBeInstanceOf(AuroraInputError);
    expect(api.quote({ ...f.request, amount: "1.5" })).rejects.toBeInstanceOf(AuroraInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("retries and rate limits", () => {
  test("waits out Retry-After on 429, even for a live quote, since rejected requests are not processed", async () => {
    const live = liveQuote();
    const limited = fixture("synthetic/rate-limited");
    const { api, calls, waits } = client([json(429, limited.body, { "retry-after": "7" }), json(200, live.response)]);
    await api.quote(live.request);
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(7_000);
  });

  test("does not block on the hourly window", async () => {
    const limited = fixture("synthetic/rate-limited");
    const { api, calls } = client([json(429, limited.body, { "retry-after": "3600" })]);
    const error = await api.incidents().catch((e) => e);
    expect(error).toBeInstanceOf(AuroraRateLimitError);
    expect(error.retryAfterSeconds).toBe(3600);
    expect(calls).toHaveLength(1);
  });

  test("retries reads after 5xx and network errors with growing backoff", async () => {
    const { api, calls, waits } = client([json(502, { message: "bad gateway", statusCode: 502 }), new TypeError("socket hang up"), fromFixture("swap/incidents")]);
    const res = await api.incidents();
    expect(res.status).toBe("incidents");
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  test("never retries a live quote after a 5xx", async () => {
    const live = liveQuote();
    const { api, calls } = client([json(500, { message: "upstream", statusCode: 500 }), json(200, live.response)]);
    const error = await api.quote(live.request).catch((e) => e);
    expect(error).toBeInstanceOf(AuroraHttpError);
    expect(error.status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  test("times out each attempt", async () => {
    const hang = (_: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const { api, calls } = client([hang, hang], { timeoutMs: 20, retries: 1 });
    expect(api.status("0xabc")).rejects.toBeInstanceOf(AuroraTimeoutError);
    await Bun.sleep(80);
    expect(calls).toHaveLength(2);
  });

  test("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user left"));
    const { api, calls } = client([fromFixture("swap/incidents")]);
    expect(api.incidents(controller.signal)).rejects.toThrow("user left");
    expect(calls).toHaveLength(0);
  });
});

describe("deposit status", () => {
  test("parses the recorded pending status", async () => {
    const { api, calls } = client([fromFixture("swap/status-pending-deposit")]);
    const res = await api.status("0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426");
    expect(new URL(calls[0]!.url).searchParams.get("depositAddress")).toBe("0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426");
    expect(res.status).toBe("PENDING_DEPOSIT");
    expect(hasDetails(res) && res.swapDetails.refundedAmount).toBe("0");
  });

  test("an unknown deposit address is a not-found error (HTTP 400 with statusCode 404)", async () => {
    const { api } = client([fromFixture("swap/status-not-found")]);
    const error = await api.status("0x1111111111111111111111111111111111111111").catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.apiStatusCode).toBe(404);
    expect(isNotFound(error)).toBe(true);
  });

  test("accepts the confidential shape, which carries only the status", async () => {
    const { api } = client([json(200, { status: "PROCESSING" })]);
    expect(hasDetails(await api.status("0xabc"))).toBe(false);
  });

  test("polls at Aurora's cadence until a terminal status", async () => {
    const seen: string[] = [];
    const { api, calls, waits } = client([
      json(200, statusLike("PENDING_DEPOSIT")),
      json(200, statusLike("KNOWN_DEPOSIT_TX")),
      json(200, statusLike("PROCESSING")),
      json(200, statusLike("SUCCESS")),
    ]);
    const final = await api.waitForSwap("0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426", { intervalMs: 1_000, onStatus: (s) => seen.push(s.status) });
    expect(final.status).toBe("SUCCESS");
    expect(seen).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([5_000, 5_000, 5_000]);
  });

  test("can stop on an incomplete deposit to prompt the user", async () => {
    const { api } = client([json(200, statusLike("INCOMPLETE_DEPOSIT"))]);
    expect((await api.waitForSwap("0xabc", { stopOn: ["INCOMPLETE_DEPOSIT"] })).status).toBe("INCOMPLETE_DEPOSIT");
  });

  test("submits the deposit hash", async () => {
    const { api, calls } = client([json(200, statusLike("KNOWN_DEPOSIT_TX"))]);
    const res = await api.submitDeposit({ txHash: "0xfeed", depositAddress: "0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426" });
    expect(calls[0]!.url).toBe(`https://intents-api.aurora.dev/api/deposit/submit/${KEY}`);
    expect(calls[0]!.body).toEqual({ txHash: "0xfeed", depositAddress: "0x8b9F5A1329c0d5376038F1d29DeB7C662B5f7426" });
    expect(res.status).toBe("KNOWN_DEPOSIT_TX");
  });
});

describe("history and incidents", () => {
  test("parses recorded incidents and both transaction shapes", async () => {
    const { api } = client([fromFixture("swap/incidents"), fromFixture("swap/transactions"), fromFixture("synthetic/transactions-paginated")]);
    const incidents = await api.incidents();
    expect(incidents.status === "incidents" && incidents.incidents[0]!.scopeType).toBe("address");
    expect(await api.transactions({ walletAddress: account })).toEqual([]);
    const [tx] = await api.transactions();
    expect(tx!.status).toBe("SUCCESS");
  });
});

describe("persistent deposit addresses", () => {
  test("a key Aurora has not approved gets 403", async () => {
    const f = fixture("persistent/create-forbidden");
    const { api } = client([json(f.status, f.body)]);
    const error = await api.createPersistentAddress(f.request).catch((e) => e);
    expect(error).toBeInstanceOf(AuroraHttpError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("not enabled for this API key");
  });

  test("creates, lists and reads deposits in the documented shapes", async () => {
    const { api, calls } = client([
      fromFixture("synthetic/persistent-create"),
      fromFixture("persistent/list"),
      fromFixture("synthetic/persistent-deposits-received"),
      fromFixture("persistent/status-not-found"),
    ]);
    const created = await api.createPersistentAddress({
      recipient: account,
      sender: "user-42",
      depositChain: "evm",
      destinationChain: "monad",
      destinationAsset: MONAD_ASSETS.USDC.assetId,
    });
    expect(created.alreadyExists).toBe(false);
    expect((await api.persistentAddresses({ perPage: 5 })).data).toEqual([]);
    const [deposit] = await api.persistentDeposits(created.depositAddress, "received");
    expect(deposit!.fromChain).toBe("arb");
    expect(new URL(calls[2]!.url).searchParams.get("type")).toBe("received");
    expect(isNotFound(await api.persistentDeposits("0x1111111111111111111111111111111111111111", "received").catch((e) => e))).toBe(true);
  });

  test("rejects an unknown chain before sending", async () => {
    const { api, calls } = client([]);
    expect(
      api.createPersistentAddress({ recipient: account, sender: "u", depositChain: "mars" as never, destinationChain: "monad", destinationAsset: "USDC" }),
    ).rejects.toBeInstanceOf(AuroraInputError);
    expect(calls).toHaveLength(0);
  });
});

describe("Trendr funding requests", () => {
  const tokens = fixture("swap/tokens").body.tokens;
  const find = (chain: string, symbol: string) => tokens.find((t: { blockchain: string; symbol: string }) => t.blockchain === chain && t.symbol === symbol);
  const monadUsdc = find("monad", "USDC");

  test("a deposit lands on the Trendr account and refunds to the sender on the origin chain", () => {
    const now = Date.parse("2026-10-09T19:00:00.000Z");
    const req = depositQuoteRequest({
      origin: find("base", "USDC"),
      destination: monadUsdc,
      amount: 10_000_000n,
      account,
      refundTo: "0x1111111111111111111111111111111111111111",
      dry: true,
      now: () => now,
    });
    expect(quoteRequestSchema.parse(req)).toEqual(req);
    const recorded = fixture("swap/quote-dry-exact-input").request;
    expect({ ...req, deadline: undefined }).toEqual({ ...recorded, slippageTolerance: 50, deadline: undefined });
    expect(req.deadline).toBe("2026-10-09T20:00:00.000Z");
  });

  test("the refund address must be able to exist on the origin chain", () => {
    const base = { destination: monadUsdc, amount: 1n, account, dry: true };
    expect(() => depositQuoteRequest({ ...base, origin: find("base", "USDC"), refundTo: "7XSfQkK1y1pX6dGqH4cJRtBZ2Ffq6dUQUh8m3WwDXqR3" })).toThrow(AuroraInputError);
    expect(() => depositQuoteRequest({ ...base, origin: find("sol", "USDC"), refundTo: account })).toThrow(AuroraInputError);
    expect(depositQuoteRequest({ ...base, origin: find("sol", "USDC"), refundTo: "7XSfQkK1y1pX6dGqH4cJRtBZ2Ffq6dUQUh8m3WwDXqR3" }).refundType).toBe("ORIGIN_CHAIN");
    expect(() => depositQuoteRequest({ ...base, origin: find("base", "USDC"), destination: find("base", "USDC"), refundTo: account })).toThrow("Monad");
  });

  test("a withdrawal refunds to the Trendr account on Monad", () => {
    const req = withdrawalQuoteRequest({ origin: monadUsdc, destination: find("arb", "USDC"), amount: 5_000_000n, account, recipient: "0x3333333333333333333333333333333333333333", dry: true });
    expect(req.refundTo).toBe(account);
    expect(req.refundType).toBe("ORIGIN_CHAIN");
    expect(() => withdrawalQuoteRequest({ origin: monadUsdc, destination: find("sol", "USDC"), amount: 1n, account, recipient: account, dry: true })).toThrow(AuroraInputError);
  });
});
