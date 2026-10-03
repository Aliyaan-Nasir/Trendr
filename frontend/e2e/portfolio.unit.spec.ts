import { OUTCOME_MARKET, type OrderBook, quoteSell } from "@trendr/contracts";
import { expect, test } from "@playwright/test";
import { amountText, coinPrice, parseAmount, signedAusd, signedPct, tokens } from "../src/features/portfolio/format";
import { kuruSellQuote, liquidationAfterMargin, outcomeValue, perpNumbers, winningsRaw } from "../src/features/portfolio/math";
import { callSharePath, parsePnlShare, pnlHeadline, pnlSharePath, xIntentUrl } from "../src/features/share/share";

/**
 * The portfolio's and share links' arithmetic, without a browser or the network: valuations,
 * liquidation prices, Kuru quotes, amount parsing, and the share links' encoding and validation.
 */

const T = 1_000_000n; // one outcome token or one AUSD, raw

test.describe("outcome valuation", () => {
  test("pairs are worth 1 AUSD, the rest at the mid", () => {
    // 5 UP and 2 DOWN: 2 pairs at 1.00, 3 unpaired UP at 0.53.
    const v = outcomeValue({ up: 5n * T, down: 2n * T, outcome: null, upMid: 0.53, downMid: 0.47 });
    expect(v.sets).toBe(2n * T);
    expect(v.value).toBeCloseTo(2 + 3 * 0.53, 9);
  });

  test("an unpaired side without a price leaves the value unknown", () => {
    expect(outcomeValue({ up: 3n * T, down: T, outcome: null, upMid: null, downMid: 0.4 }).value).toBeNull();
    // Pairs alone never need a price.
    expect(outcomeValue({ up: T, down: T, outcome: null, upMid: null, downMid: null }).value).toBe(1);
  });

  test("settled series pay the winner 1, the loser 0, and void half of each (rounded down)", () => {
    expect(outcomeValue({ up: 4n * T, down: T, outcome: 1, upMid: null, downMid: null }).value).toBe(4);
    expect(outcomeValue({ up: 4n * T, down: T, outcome: 2, upMid: null, downMid: null }).value).toBe(1);
    expect(winningsRaw(3, 3n, 5n)).toBe(1n + 2n);
    expect(outcomeValue({ up: 3n * T, down: T, outcome: 3, upMid: null, downMid: null }).value).toBe(2);
  });
});

test.describe("attention perp numbers", () => {
  // AttentionPerp: unit 1e6, so 1e18 qty moves 1 AUSD per index point.
  const unit = 1_000_000n;
  const qty = (notional: number, index: number) => BigInt(Math.round((notional / index) * 1e18));
  const maintenanceGap = (isLong: boolean, q: bigint, entryEquity: number, i0: number, x: number) => {
    const k = Number(q) / 1e18;
    const equity = entryEquity + (isLong ? 1 : -1) * k * (x - i0);
    return equity - 0.1 * k * x;
  };

  test("a long's liquidation index is where equity meets the 10% maintenance", () => {
    const q = qty(10, 60);
    const n = perpNumbers({ isLong: true, qty: q, unit, index: 60, margin: 5n * T, equity: 5n * T });
    expect(n.leverage).toBeCloseTo(2, 6);
    expect(n.liquidationIndex).not.toBeNull();
    expect(n.liquidationIndex!).toBeLessThan(60);
    expect(maintenanceGap(true, q, 5, 60, n.liquidationIndex!)).toBeCloseTo(0, 6);
  });

  test("a short's liquidation index is above the market", () => {
    const q = qty(15, 50);
    const n = perpNumbers({ isLong: false, qty: q, unit, index: 50, margin: 5n * T, equity: 5n * T });
    expect(n.liquidationIndex!).toBeGreaterThan(50);
    expect(maintenanceGap(false, q, 5, 50, n.liquidationIndex!)).toBeCloseTo(0, 6);
  });

  test("PnL is equity over margin, and added margin moves liquidation away", () => {
    const q = qty(10, 60);
    const p = { isLong: true, qty: q, unit, index: 60, equity: 4_500_000n };
    const n = perpNumbers({ ...p, margin: 5n * T });
    expect(n.pnl).toBeCloseTo(-0.5, 9);
    expect(n.pnlPct).toBeCloseTo(-10, 9);
    expect(liquidationAfterMargin(p, T)!).toBeLessThan(n.liquidationIndex!);
  });

  test("an unleveraged long can never be liquidated in range", () => {
    const n = perpNumbers({ isLong: true, qty: qty(5, 60), unit, index: 60, margin: 10n * T, equity: 10n * T });
    expect(n.liquidationIndex).toBeNull();
  });
});

test.describe("Kuru sell quotes", () => {
  const book: OrderBook = {
    bids: [
      { price: 5_300, size: 300n },
      { price: 5_200, size: 1_000n },
    ],
    asks: [{ price: 5_400, size: 500n }],
  };

  test("match the outcome-market quote for outcome precisions", () => {
    const params = { pricePrecision: OUTCOME_MARKET.pricePrecision, sizePrecision: OUTCOME_MARKET.sizePrecision, baseDecimals: 6, quoteDecimals: 6, takerFeeBps: OUTCOME_MARKET.takerFeeBps };
    for (const amount of [T, 5n * T, 7_500_000n, 13n * T]) {
      const generic = kuruSellQuote(book, params, amount);
      const outcome = quoteSell(book, amount);
      expect(generic.out).toBe(outcome.out);
      expect(generic.complete).toBe(outcome.complete);
    }
  });

  test("say when the book is too thin", () => {
    const params = { pricePrecision: 10_000, sizePrecision: 100, baseDecimals: 6, quoteDecimals: 6, takerFeeBps: 10 };
    expect(kuruSellQuote(book, params, 20n * T).complete).toBe(false);
  });
});

test.describe("amounts", () => {
  test("parse what people type", () => {
    expect(parseAmount("1", 6)).toBe(T);
    expect(parseAmount("1,234.5", 6)).toBe(1_234_500_000n);
    expect(parseAmount(".5", 6)).toBe(500_000n);
    expect(parseAmount("0.1234567", 6)).toBe(123_456n);
    for (const bad of ["", ".", "0", "abc", "1.2.3", "-1"]) expect(parseAmount(bad, 6)).toBeNull();
  });

  test("Max writes the exact balance, never more", () => {
    const coins = 1_234_567_890_123_456_789n; // 18 decimals: beyond a float's precision
    const text = amountText(coins, 18, 6);
    expect(text).toBe("1.234567");
    expect(parseAmount(text, 18)!).toBeLessThanOrEqual(coins);
    expect(amountText(7_630_000n, 6)).toBe("7.63");
    expect(amountText(2n * T, 6)).toBe("2");
  });

  test("formats tokens and signs, never a negative zero", () => {
    expect(tokens(7_634_999n)).toBe("7.63");
    expect(tokens(1_234_567_000_000n)).toBe("1,234,567.00");
    expect(signedAusd(-0.001)).toBe("0.00");
    expect(signedAusd(1.234)).toBe("+1.23");
    expect(signedAusd(-1.235)).toBe("-1.24");
    expect(signedPct(-0.04)).toBe("0.0%");
    expect(signedPct(12.345)).toBe("+12.3%");
    expect(coinPrice(0.0000020237)).toBe("0.000002024");
    expect(coinPrice(1.5)).toBe("1.5");
    expect(coinPrice(null)).toBe("-");
  });
});

test.describe("share links", () => {
  const share = { kind: "attention" as const, market: "Ethereum", side: "long" as const, pnl: 12.4, roi: 24.8, entry: 84.93, exit: 91.2, leverage: 2, tx: `0x${"ab".repeat(32)}` as `0x${string}`, identifier: "crypto:eth" };

  test("a PnL link round-trips", () => {
    const path = pnlSharePath(share);
    expect(path.startsWith("/share/pnl?")).toBe(true);
    expect(parsePnlShare(new URLSearchParams(path.split("?")[1]))).toEqual(share);
    expect(pnlHeadline(share)).toBe("Ethereum attention, long 2x");
    expect(pnlHeadline({ ...share, kind: "outcome", side: "up", leverage: null })).toBe("Ethereum, UP");
  });

  test("bad links read as nothing, and text is cleaned", () => {
    expect(parsePnlShare(new URLSearchParams("k=attention&m=X&s=long"))).toBeNull();
    expect(parsePnlShare(new URLSearchParams("k=moon&m=X&s=long&p=1"))).toBeNull();
    expect(parsePnlShare(new URLSearchParams("k=perpl&m=BTC&s=long&p=abc"))).toBeNull();
    const odd = parsePnlShare({ k: "perpl", m: "BTC‮\u0007 perp", s: "short", p: "-3.2", tx: "0x123", t: "Bad Id!" })!;
    expect(odd.market).toBe("BTC perp");
    expect(odd.tx).toBeNull();
    expect(odd.identifier).toBeNull();
    expect(parsePnlShare({ k: "coin", m: "x".repeat(200), s: "hold", p: "1" })!.market).toHaveLength(48);
  });

  test("the X intent and call links are encoded", () => {
    const url = new URL(xIntentUrl({ text: "Up 12% & rising", url: "https://trendr.example/t/crypto:eth" }));
    expect(url.origin + url.pathname).toBe("https://twitter.com/intent/tweet");
    expect(url.searchParams.get("text")).toBe("Up 12% & rising");
    expect(url.searchParams.get("url")).toBe("https://trendr.example/t/crypto:eth");
    expect(callSharePath("topic:world-cup", 7)).toBe("/share/call/topic%3Aworld-cup/7");
  });
});
