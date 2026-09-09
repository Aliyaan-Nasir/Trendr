import { describe, expect, test } from "bun:test";
import {
  type AuroraToken,
  type DepositState,
  depositFromQuote,
  describeDeposit,
  formatEta,
  isSettled,
  nextPollMs,
  type QuoteResponse,
  transferRequirements,
  withClock,
  withDepositTx,
  withStatus,
} from "../src";
import { EM_DASH, fixture, statusLike } from "./helpers";

const tokens: AuroraToken[] = fixture("swap/tokens").body.tokens;
const token = (chain: string, symbol: string) => tokens.find((t) => t.blockchain === chain && t.symbol === symbol)!;
const baseUsdc = token("base", "USDC");
const monadUsdc = token("monad", "USDC");

const T0 = Date.parse("2026-10-09T19:15:20.000Z");
const DEPOSIT_TX = "0xdeposit000000000000000000000000000000000000000000000000000000aa";
const REFUND_TX = "0xrefund0000000000000000000000000000000000000000000000000000000bb";
const MONAD_TX = "0xmonad00000000000000000000000000000000000000000000000000000000cc";
const tx = (hash: string, explorer: string) => ({ hash, explorerUrl: `https://${explorer}/tx/${hash}` });

/** The recorded dry quote (Base USDC to Monad USDC), made live with the documented extra fields. */
function liveQuote(): QuoteResponse {
  const dry = fixture<QuoteResponse>("swap/quote-dry-exact-input").body;
  return {
    ...dry,
    quoteRequest: { ...dry.quoteRequest, dry: false },
    quote: {
      ...dry.quote,
      depositAddress: "0x5f1b9C3e2A7d4B6c8E0f1A2b3C4d5E6f7A8b9C0d",
      deadline: "2026-10-09T19:45:19.000Z",
      timeWhenInactive: "2026-10-12T19:45:19.000Z",
    },
  };
}

const start = () => depositFromQuote(liveQuote(), { origin: baseUsdc, destination: monadUsdc }, T0);
const phases = (s: DepositState) => s.history.map((h) => h.phase);

describe("starting a deposit", () => {
  test("a dry quote is only quoted; a live one waits for the deposit", () => {
    const dry = depositFromQuote(fixture("swap/quote-dry-exact-input").body, { origin: baseUsdc, destination: monadUsdc }, T0);
    expect(dry.phase).toBe("quoted");
    expect(dry.depositAddress).toBeUndefined();
    expect(nextPollMs(dry)).toBeNull();
    const live = start();
    expect(live.phase).toBe("awaiting_deposit");
    expect(live.refundTo).toBe("0x1111111111111111111111111111111111111111");
    expect(live.recipient).toBe("0x2222222222222222222222222222222222222222");
    expect(live.timeEstimateSeconds).toBe(37);
    expect(nextPollMs(live)).toBe(6_000);
  });

  test("refuses tokens that are not the quote's", () => {
    expect(() => depositFromQuote(liveQuote(), { origin: token("arb", "USDC"), destination: monadUsdc })).toThrow();
  });

  test("is plain JSON, so the backend can store and resume it", () => {
    const s = withStatus(withDepositTx(start(), DEPOSIT_TX, T0 + 1), statusLike("PROCESSING"), T0 + 2);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("the happy path", () => {
  test("detected, processing, then USDC delivered on Monad with the tx hash and amount", () => {
    let s = start();
    s = withDepositTx(s, DEPOSIT_TX, T0 + 10_000);
    expect(s.phase).toBe("deposit_detected");
    s = withStatus(s, statusLike("KNOWN_DEPOSIT_TX", { originChainTxHashes: [tx(DEPOSIT_TX, "basescan.org")] }), T0 + 15_000);
    s = withStatus(s, statusLike("PROCESSING", { depositedAmount: "10000000", depositedAmountFormatted: "10.0" }), T0 + 25_000);
    expect(s.phase).toBe("processing");
    s = withStatus(
      s,
      statusLike("SUCCESS", {
        amountOut: "9995310",
        amountOutFormatted: "9.99531",
        originChainTxHashes: [tx(DEPOSIT_TX, "basescan.org")],
        destinationChainTxHashes: [tx(MONAD_TX, "monadscan.com")],
      }),
      T0 + 50_000,
    );
    expect(s.phase).toBe("succeeded");
    expect(isSettled(s)).toBe(true);
    expect(nextPollMs(s)).toBeNull();
    expect(s.outcome).toEqual({
      kind: "success",
      amountOut: "9995310",
      amountOutFormatted: "9.99531",
      monadTxHashes: [MONAD_TX],
      explorerUrls: [`https://monadscan.com/tx/${MONAD_TX}`],
    });
    expect(s.depositTxHashes).toEqual([DEPOSIT_TX]);
    expect(phases(s)).toEqual(["awaiting_deposit", "deposit_detected", "processing", "succeeded"]);
    const message = describeDeposit(s);
    expect(message.body).toBe("9.99531 USDC arrived in your Trendr account.");
    expect(message.links).toEqual([`https://monadscan.com/tx/${MONAD_TX}`]);
  });

  test("never moves backwards and never changes after settling", () => {
    let s = withStatus(start(), statusLike("PROCESSING"), T0 + 1);
    s = withStatus(s, statusLike("PENDING_DEPOSIT"), T0 + 2);
    s = withStatus(s, statusLike("KNOWN_DEPOSIT_TX"), T0 + 3);
    expect(s.phase).toBe("processing");
    s = withStatus(s, statusLike("SUCCESS", { amountOut: "9995310" }), T0 + 4);
    const settled = s;
    s = withStatus(s, statusLike("REFUNDED", { refundedAmount: "10000000" }), T0 + 5);
    expect(s).toBe(settled);
  });

  test("an app-reported deposit is not undone by a status that has not caught up", () => {
    let s = withDepositTx(start(), DEPOSIT_TX, T0 + 1);
    s = withStatus(s, statusLike("PENDING_DEPOSIT"), T0 + 2);
    expect(s.phase).toBe("deposit_detected");
    expect(s.auroraStatus).toBe("PENDING_DEPOSIT");
  });
});

describe("refunds", () => {
  test("separates the refund transaction from the deposit", () => {
    let s = withStatus(start(), statusLike("KNOWN_DEPOSIT_TX", { originChainTxHashes: [tx(DEPOSIT_TX, "basescan.org")] }), T0 + 1);
    s = withStatus(
      s,
      statusLike("REFUNDED", {
        refundedAmount: "9997600",
        refundedAmountFormatted: "9.9976",
        refundReason: "Deposit below the minimum",
        originChainTxHashes: [tx(DEPOSIT_TX, "basescan.org"), tx(REFUND_TX, "basescan.org")],
      }),
      T0 + 2,
    );
    expect(s.phase).toBe("refunded");
    expect(s.depositTxHashes).toEqual([DEPOSIT_TX]);
    expect(s.outcome).toEqual({
      kind: "refund",
      refundedAmount: "9997600",
      refundedAmountFormatted: "9.9976",
      refundReason: "Deposit below the minimum",
      refundTo: "0x1111111111111111111111111111111111111111",
      refundTxHashes: [REFUND_TX],
      explorerUrls: [`https://basescan.org/tx/${REFUND_TX}`],
    });
    expect(describeDeposit(s).body).toBe(
      "9.9976 USDC was sent back to 0x1111111111111111111111111111111111111111 on Base. Reason: Deposit below the minimum.",
    );
  });

  test("a refund seen before the deposit still labels the first transaction as the deposit", () => {
    const both = withStatus(start(), statusLike("REFUNDED", { originChainTxHashes: [tx(DEPOSIT_TX, "b"), tx(REFUND_TX, "b")] }), T0 + 1);
    expect(both.depositTxHashes).toEqual([DEPOSIT_TX]);
    expect(both.outcome?.kind === "refund" && both.outcome.refundTxHashes).toEqual([REFUND_TX]);
    const one = withStatus(start(), statusLike("REFUNDED", { originChainTxHashes: [tx(DEPOSIT_TX, "b")] }), T0 + 1);
    expect(one.depositTxHashes).toEqual([DEPOSIT_TX]);
    expect(one.outcome?.kind === "refund" && one.outcome.refundTxHashes).toEqual([]);
  });

  test("a short deposit asks for the rest before the deadline, then may be refunded", () => {
    let s = withStatus(start(), statusLike("INCOMPLETE_DEPOSIT", { depositedAmount: "4000000", depositedAmountFormatted: "4.0" }), T0 + 1);
    expect(s.phase).toBe("incomplete_deposit");
    const message = describeDeposit(s);
    expect(message.action).toBe("top_up");
    expect(message.body).toBe(
      "Received 4.0 USDC, but at least 10 USDC is needed. Send the rest to the same address before 2026-10-09 19:45 UTC, or it is refunded to 0x1111111111111111111111111111111111111111 on Base.",
    );
    s = withStatus(s, statusLike("REFUNDED", { refundedAmount: "4000000" }), T0 + 2);
    expect(s.phase).toBe("refunded");
  });

  test("a failure points to support and can still be refined to a refund", () => {
    let s = withStatus(start(), statusLike("FAILED", { originChainTxHashes: [tx(DEPOSIT_TX, "b")] }), T0 + 1);
    expect(s.phase).toBe("failed");
    expect(nextPollMs(s)).toBeNull();
    const message = describeDeposit(s);
    expect(message.action).toBe("contact_support");
    expect(message.support).toEqual({ depositAddress: "0x5f1b9C3e2A7d4B6c8E0f1A2b3C4d5E6f7A8b9C0d", txHashes: [DEPOSIT_TX] });
    s = withStatus(s, statusLike("REFUNDED", { refundedAmount: "10000000", originChainTxHashes: [tx(DEPOSIT_TX, "b"), tx(REFUND_TX, "b")] }), T0 + 2);
    expect(s.phase).toBe("refunded");
    expect(s.outcome?.kind).toBe("refund");
  });

  test("confidential swaps settle by status alone", () => {
    const s = withStatus(start(), { status: "SUCCESS" }, T0 + 1);
    expect(s.phase).toBe("succeeded");
    expect(s.outcome).toEqual({ kind: "success", amountOut: liveQuote().quote.amountOut, monadTxHashes: [], explorerUrls: [] });
  });
});

describe("expiry", () => {
  test("an unfunded quote expires at its deadline and stays expired while nothing arrives", () => {
    let s = withClock(start(), T0 + 60_000);
    expect(s.phase).toBe("awaiting_deposit");
    s = withClock(s, Date.parse("2026-10-09T19:45:19.000Z"));
    expect(s.phase).toBe("expired");
    expect(describeDeposit(s).action).toBe("new_quote");
    s = withStatus(s, statusLike("PENDING_DEPOSIT"), Date.parse("2026-10-09T19:50:00.000Z"));
    expect(s.phase).toBe("expired");
    expect(nextPollMs(s, Date.parse("2026-10-10T00:00:00.000Z"))).toBe(60_000);
    expect(nextPollMs(s, Date.parse("2026-10-13T00:00:00.000Z"))).toBeNull();
  });

  test("a late deposit is still tracked", () => {
    let s = withClock(start(), Date.parse("2026-10-09T20:00:00.000Z"));
    s = withStatus(s, statusLike("KNOWN_DEPOSIT_TX", { originChainTxHashes: [tx(DEPOSIT_TX, "b")] }), Date.parse("2026-10-09T20:01:00.000Z"));
    expect(s.phase).toBe("deposit_detected");
    expect(phases(s)).toEqual(["awaiting_deposit", "expired", "deposit_detected"]);
  });
});

describe("what the user sees", () => {
  test("the deposit address comes with data-driven transfer requirements", () => {
    const s = start();
    const message = describeDeposit(s);
    expect(message.title).toBe("Send 10.0 USDC on Base");
    expect(message.action).toBe("send");
    expect(message.requirements).toEqual(transferRequirements(s));
    expect(message.requirements).toEqual([
      "1 asset supported: send only USDC from Base to this address.",
      "Send exactly 10.0 USDC. Less is refunded; more is swapped and the excess refunded.",
      "Send before 2026-10-09 19:45 UTC.",
      "Sending another asset or using another network may result in permanent loss of funds.",
      "If the deposit cannot complete, it is refunded to 0x1111111111111111111111111111111111111111 on Base.",
    ]);
  });

  test("every phase has short, plain copy without em dashes", () => {
    const base = start();
    const states: DepositState[] = [
      depositFromQuote(fixture("swap/quote-dry-exact-input").body, { origin: baseUsdc, destination: monadUsdc }, T0),
      base,
      withDepositTx(base, DEPOSIT_TX),
      withStatus(base, statusLike("INCOMPLETE_DEPOSIT", { depositedAmount: "1" })),
      withStatus(base, statusLike("PROCESSING")),
      withStatus(base, statusLike("SUCCESS")),
      withStatus(base, statusLike("REFUNDED")),
      withStatus(base, statusLike("FAILED")),
      withClock(base, Date.parse("2026-10-10T00:00:00.000Z")),
    ];
    expect(new Set(states.map((s) => s.phase)).size).toBe(9);
    for (const s of states) {
      const m = describeDeposit(s, { formatTime: () => "19:45" });
      for (const text of [m.title, m.body, ...m.requirements]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThan(220);
        expect(text).not.toContain(EM_DASH);
      }
    }
  });

  test("time estimates read naturally", () => {
    expect(formatEta(37)).toBe("about 40 seconds");
    expect(formatEta(809)).toBe("about 13 minutes");
  });
});
