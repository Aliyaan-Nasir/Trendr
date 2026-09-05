import { describe, expect, test } from "bun:test";
import { type Hex, hashTypedData, keccak256, stringToBytes } from "viem";
import { canonicalJson, ownerApprovalDigest, ownerParamsHash, ownerRequests } from "../src";

const account = "0x00000000000000000000000000000000000000a1";
const nonce: Hex = `0x${"11".repeat(32)}`;
const base = { chainId: 10143, account, nonce, expiresAt: 1_800_000_300 } as const;

describe("canonicalJson", () => {
  test("sorts keys at every level, keeps array order and drops undefined fields", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" }, e: undefined })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(canonicalJson({ a: [undefined, null, true] })).toBe('{"a":[null,null,true]}');
    // A JSON round trip (what the backend receives) hashes the same as the object the app built.
    const settings = { mode: "ratio", ratio: 0.5, fixedMarginAusd: 0, maxMarginAusd: 30, maxLeverage: 2, maxDailyLossAusd: 10 };
    expect(canonicalJson(JSON.parse(JSON.stringify(settings)))).toBe(canonicalJson(settings));
  });

  test("refuses values JSON cannot carry", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow("finite");
    expect(() => canonicalJson({ a: 1n })).toThrow("bigint");
  });
});

describe("ownerApprovalDigest", () => {
  const follow = ownerRequests.follow("0x6CFACB4C9A1B63CBC87750EC471CE194BFEA0211", { mode: "ratio", ratio: 1 });

  test("is EIP-712 over the action, the account, the params hash, the nonce and the expiry, on the chain", () => {
    const expected = hashTypedData({
      domain: { name: "Trendr API", version: "1", chainId: 10143 },
      types: {
        OwnerApproval: [
          { name: "action", type: "string" },
          { name: "account", type: "address" },
          { name: "paramsHash", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      primaryType: "OwnerApproval",
      message: {
        action: "follow",
        account,
        paramsHash: keccak256(stringToBytes('{"leader":"0x6cfacb4c9a1b63cbc87750ec471ce194bfea0211","settings":{"mode":"ratio","ratio":1}}')),
        nonce,
        expiresAt: 1_800_000_300n,
      },
    });
    expect(ownerApprovalDigest({ ...base, request: follow })).toBe(expected);
  });

  test("changes with every field it binds", () => {
    const d = ownerApprovalDigest({ ...base, request: follow });
    const variants = [
      ownerApprovalDigest({ ...base, chainId: 143, request: follow }),
      ownerApprovalDigest({ ...base, account: "0x00000000000000000000000000000000000000a2", request: follow }),
      ownerApprovalDigest({ ...base, nonce: `0x${"22".repeat(32)}`, request: follow }),
      ownerApprovalDigest({ ...base, expiresAt: base.expiresAt + 1, request: follow }),
      ownerApprovalDigest({ ...base, request: { ...follow, action: "enable-rule" } }),
      ownerApprovalDigest({ ...base, request: ownerRequests.follow("0x6cfacb4c9a1b63cbc87750ec471ce194bfea0211", { mode: "ratio", ratio: 2 }) }),
    ];
    for (const v of variants) expect(v).not.toBe(d);
    expect(new Set(variants).size).toBe(variants.length);
  });

  test("a follow binds every setting, the slippage limit and the loss cap included", () => {
    const settings = { mode: "ratio", ratio: 1, fixedMarginAusd: 0, maxMarginAusd: 40, maxLeverage: 2, maxDailyLossAusd: 20, maxSlippagePct: 0.3, maxOpenLossAusd: 15 };
    const hash = (s: object) => ownerParamsHash(ownerRequests.follow("0x6cfacb4c9a1b63cbc87750ec471ce194bfea0211", s).params);
    const h = hash(settings);
    const changed = Object.keys(settings).map((k) => hash({ ...settings, [k]: k === "mode" ? "fixed" : (settings[k as keyof typeof settings] as number) + 0.01 }));
    for (const v of changed) expect(v).not.toBe(h);
    expect(new Set(changed).size).toBe(changed.length);
    // Leaving a setting out (the server then stores its default) is a different approval too.
    const { maxSlippagePct: _, ...without } = settings;
    expect(hash(without)).not.toBe(h);
    expect(hash(JSON.parse(JSON.stringify(settings)))).toBe(h);
  });

  test("addresses and rule hashes are case-insensitive; key order is not part of the params", () => {
    expect(ownerParamsHash(ownerRequests.linkIdentity("0xABCDEF0000000000000000000000000000000001").params)).toBe(
      ownerParamsHash(ownerRequests.linkIdentity("0xabcdef0000000000000000000000000000000001").params),
    );
    expect(ownerParamsHash(ownerRequests.enableRule(7, "0xAB").params)).toBe(ownerParamsHash({ ruleHash: "0xab", rule: 7 }));
    expect(ownerParamsHash(ownerRequests.resumeFollow(7).params)).not.toBe(ownerParamsHash(ownerRequests.enableRule(7, "0xab").params));
  });
});
