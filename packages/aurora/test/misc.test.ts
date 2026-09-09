import { describe, expect, test } from "bun:test";
import { addressFamily, base58Decode, base58Encode, chainName, feeSplit, isAddressOn } from "../src";

describe("base58", () => {
  const vectors: [string, string][] = [
    ["", ""],
    ["61", "2g"],
    ["626262", "a3gV"],
    ["636363", "aPEr"],
    ["00000000000000000000", "1111111111"],
    ["000111d38e5fc9071ffcd20b4a763cc9ae4f252bb4e48fd66a835e252ada93ff480d6dd43dc62a641155a5", "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"],
  ];
  for (const [hex, text] of vectors) {
    test(`${hex || "empty"} <-> ${text || "empty"}`, () => {
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      expect(base58Encode(bytes)).toBe(text);
      expect(Buffer.from(base58Decode(text)).toString("hex")).toBe(hex);
    });
  }
  test("rejects characters outside the alphabet", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});

describe("chains", () => {
  test("names and address families", () => {
    expect(chainName("arb")).toBe("Arbitrum");
    expect(chainName("unknownchain")).toBe("UNKNOWNCHAIN");
    expect(addressFamily("monad")).toBe("evm");
    expect(addressFamily("sol")).toBe("solana");
    expect(addressFamily("btc")).toBe("other");
  });

  test("refund addresses are checked for EVM and Solana, and left to Aurora elsewhere", () => {
    expect(isAddressOn("base", "0x1111111111111111111111111111111111111111")).toBe(true);
    expect(isAddressOn("base", "0x1234")).toBe(false);
    expect(isAddressOn("sol", "7XSfQkK1y1pX6dGqH4cJRtBZ2Ffq6dUQUh8m3WwDXqR3")).toBe(true);
    expect(isAddressOn("sol", "0x1111111111111111111111111111111111111111")).toBe(false);
    expect(isAddressOn("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe(true);
    expect(isAddressOn("btc", " ")).toBe(false);
  });
});

describe("fees", () => {
  // The table on https://docs.intents.aurora.dev/getting-started/api-keys-and-fees.
  const table: [number, number, number, number][] = [
    [0, 0, 2, 10],
    [5, 3, 2, 10],
    [10, 6, 4, 10],
    [20, 12, 8, 10],
    [30, 18, 12, 12],
  ];
  for (const [fee, share, stable, nonStable] of table) {
    test(`${fee} bps integrator fee`, () => {
      expect(feeSplit(fee, "stable")).toEqual({ integratorBps: share, auroraBps: stable, totalBps: share + stable });
      expect(feeSplit(fee, "non-stable").auroraBps).toBe(nonStable);
    });
  }
  test("caps the integrator fee at 500 bps", () => {
    expect(() => feeSplit(501, "stable")).toThrow();
  });
});
