import { describe, expect, test } from "bun:test";
import * as ed from "@noble/ed25519";
import { decodeAbiParameters, decodeFunctionData, hashTypedData, hexToBytes, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  builderExtension,
  canonicalRequest,
  closeMarketOrder,
  encodeExecOrder,
  enrollApiKey,
  exchangeAbi,
  openAccountCalls,
  openMarketOrder,
  OrderType,
  PERPL_NETWORKS,
  type PerplMarket,
  PerplApi,
  toPriceUnits,
  tradingSignIn,
  worstPrice,
} from "../src";

const btc: PerplMarket = {
  id: 16,
  name: "BTC Perp",
  symbol: "BTC",
  priceDecimals: 1,
  sizeDecimals: 5,
  maxLeverage: 15,
  maintenanceMargin: 0.04,
  defaultMnp: 1000,
  maxSlippageBps: 1000,
  orderTtlBlocks: 20,
  isOpen: true,
};
const testnet = PERPL_NETWORKS[10143]!;
const fromBase64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

describe("request signing", () => {
  test("builds Perpl's documented canonical string", async () => {
    const canonical = await canonicalRequest(143, "GET", "/v1/trading/fills?count=1", "1751932800000", "9Nq0Yp3kZ2c1aVb7", "");
    expect(canonical).toBe(
      ["143", "GET", "/v1/trading/fills?count=1", "1751932800000", "9Nq0Yp3kZ2c1aVb7", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"].join(
        "\n",
      ),
    );
  });

  test("signs every request so the server can verify it", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const publicKey = await ed.getPublicKeyAsync(secretKey);
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({ mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] });
    }) as unknown as typeof fetch;
    const api = new PerplApi(testnet, { token: "tok", secretKey }, fakeFetch, () => 1_800_000_000_000);
    const order = { rq: 7, mkt: 16, acc: 3, t: 1, p: 0, s: 100, fl: 4, lv: 200, lb: 0 };
    await api.submit([order]);

    const { url, init } = seen!;
    expect(url).toBe("https://testnet.perpl.xyz/api/v1/trading/orders");
    const h = init.headers as Record<string, string>;
    expect(h["X-API-Key"]).toBe("tok");
    expect(h["X-API-Timestamp"]).toBe("1800000000000");
    const canonical = await canonicalRequest(10143, "POST", "/v1/trading/orders", h["X-API-Timestamp"]!, h["X-API-Nonce"]!, init.body as string);
    expect(await ed.verifyAsync(fromBase64Url(h["X-API-Signature"]!), new TextEncoder().encode(canonical), publicKey)).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({ d: [order] });
  });

  test("signs the trading WebSocket sign-in", async () => {
    const secretKey = ed.utils.randomSecretKey();
    const frame = await tradingSignIn(10143, { token: "tok", secretKey }, 1_800_000_000_000);
    const canonical = ["10143", "trading-ws-signin", frame.timestamp, frame.nonce].join("\n");
    expect(frame.mt).toBe(29);
    expect(await ed.verifyAsync(fromBase64Url(frame.signature), new TextEncoder().encode(canonical), await ed.getPublicKeyAsync(secretKey))).toBe(true);
  });
});

describe("enrollment", () => {
  test("signs Perpl's typed data with the account and proves the key over its digest", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const typedData = {
      domain: { name: "Perpl", version: "1", chainId: 10143 },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        ApiKey: [
          { name: "publicKey", type: "bytes32" },
          { name: "scope", type: "uint32" },
        ],
      },
      primaryType: "ApiKey",
      message: { publicKey: `0x${"11".repeat(32)}`, scope: 3 },
    };
    const calls: { path: string; body: Record<string, unknown>; origin?: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push({ path: new URL(url).pathname, body, origin: (init.headers as Record<string, string>).Origin });
      if (url.endsWith("/payload")) return Response.json({ typed_data: typedData, mac: "m" });
      return Response.json({ api_key: { api_key: "token-1", scope_mask: 3 } });
    }) as unknown as typeof fetch;

    const key = await enrollApiKey({
      network: testnet,
      signer: { address: account.address, signTypedData: (td) => account.signTypedData(td as never) },
      label: "Trendr autopilot",
      scope: 3,
      builder: { id: 7, maxFeePer100k: 50 },
      origin: "https://app.trendr.test",
      fetchFn: fakeFetch,
    });
    expect(key.token).toBe("token-1");
    expect(calls[0]!.path).toBe("/api/v1/api-key/payload");
    expect(calls[0]!.body).toMatchObject({ chain_id: 10143, scope_mask: 3, builder_id: 7, max_builder_fee_per_100k: 50 });
    expect(calls[0]!.origin).toBe("https://app.trendr.test");

    const enroll = calls[1]!.body;
    expect(enroll.mac).toBe("m");
    const { EIP712Domain: _d, ...types } = typedData.types;
    const typed = { domain: typedData.domain, types, primaryType: "ApiKey", message: typedData.message } as const;
    expect(await recoverTypedDataAddress({ ...(typed as object), signature: enroll.signature as `0x${string}` } as never)).toBe(account.address);
    const pop = hexToBytes(enroll.pop_signature as `0x${string}`);
    const digest = hexToBytes(hashTypedData(typed as never));
    expect(await ed.verifyAsync(pop, digest, await ed.getPublicKeyAsync(key.secretKey))).toBe(true);
  });
});

describe("orders", () => {
  test("scale prices, sizes and leverage to the market", () => {
    const desc = openMarketOrder({ market: btc, requestId: 5n, side: "long", size: 0.00123, worstPrice: 82610.44, leverage: 2 });
    expect(desc.orderType).toBe(OrderType.OpenLong);
    expect(desc.pricePNS).toBe(826104n);
    expect(desc.lotLNS).toBe(123n);
    expect(desc.leverageHdths).toBe(200n);
    expect(desc.immediateOrCancel).toBe(true);
    expect(desc.maxNegPnlCollatBPS).toBe(1000n);
    expect(() => openMarketOrder({ market: btc, requestId: 1n, side: "long", size: 1, worstPrice: 1, leverage: 16 })).toThrow();

    const close = closeMarketOrder({ market: btc, requestId: 6n, side: "short", size: 0.00123, worstPrice: worstPrice("long", 82610, 100) });
    expect(close.orderType).toBe(OrderType.CloseShort);
    expect(close.pricePNS).toBe(toPriceUnits(btc, 82610 * 1.01));
  });

  test("encode execOrder and the builder extension as the Exchange expects", () => {
    const desc = openMarketOrder({ market: btc, requestId: 5n, side: "short", size: 0.001, worstPrice: 80000, leverage: 3 });
    const decoded = decodeFunctionData({ abi: exchangeAbi, data: encodeExecOrder(desc) });
    expect(decoded.functionName).toBe("execOrder");
    const [version, payload] = decodeAbiParameters([{ type: "uint16" }, { type: "bytes" }], builderExtension(7, 50));
    expect(version).toBe(1);
    expect(decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], payload)).toEqual([7n, 50n]);
    expect(() => builderExtension(0, 1)).toThrow();
  });

  test("open an account with an exact approval and forwarding", () => {
    const calls = openAccountCalls(testnet.exchange, testnet.collateral, 100_000_000n, true);
    expect(calls.map((c) => c.target)).toEqual([testnet.collateral, testnet.exchange, testnet.exchange]);
    expect(decodeFunctionData({ abi: exchangeAbi, data: calls[1]!.data })).toMatchObject({ functionName: "createAccount", args: [100_000_000n] });
    expect(decodeFunctionData({ abi: exchangeAbi, data: calls[2]!.data })).toMatchObject({ functionName: "allowOrderForwarding", args: [true] });
  });
});
