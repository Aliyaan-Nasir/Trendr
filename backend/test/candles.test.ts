import { describe, expect, test } from "bun:test";
import { PERPL_NETWORKS, type PerplMarket } from "@trendr/perpl";
import { AutopilotService, PAST_CANDLE_PAGE_MS } from "../src/autopilot/service";
import { json } from "./helpers";

/**
 * Perpl candles behind a short cache: backtests of any length share pages on a fixed grid, a page
 * in the past is kept longer than the one still filling in, and nothing failed is kept.
 */

const BTC: PerplMarket = { id: 16, name: "BTC Perp", symbol: "BTC", priceDecimals: 1, sizeDecimals: 5, maxLeverage: 15, maintenanceMargin: 0.04, defaultMnp: 1000, maxSlippageBps: 1000, orderTtlBlocks: 20, isOpen: true };
/** Five-minute pages hold 1,000 candles: 300,000 seconds. */
const PAGE = 300_000;
const NOW = 6_000 * PAGE + 123_456;

function setup() {
  const requests: Array<{ from: number; to: number }> = [];
  let fail = false;
  let clock = NOW * 1000;
  const fetchImpl = async (url: string) => {
    const [from, to] = /\/candles\/300\/(\d+)-(\d+)$/.exec(url)!.slice(1).map((v) => Number(v) / 1000) as [number, number];
    requests.push({ from, to });
    if (fail) return json({ error: "busy" }, 503);
    // As Perpl does: a range that ends in the future is a bad request.
    if (to > clock / 1000) return json({ error: "Bad Request" }, 400);
    // Every five minutes up to the clock, priced at its own time.
    const d = [];
    for (let t = from; t < Math.min(to, clock / 1000); t += 300) d.push({ t: t * 1000, o: t, h: t, l: t, c: t, v: "0", n: 1 });
    return json({ d });
  };
  const service = new AutopilotService({} as never, {} as never, {} as never, PERPL_NETWORKS[10143]!, { takerFeeBps: 4, slippageBps: 5 }, fetchImpl as never, () => clock);
  return {
    service,
    requests,
    advance: (ms: number) => (clock += ms),
    failNext: (v: boolean) => (fail = v),
  };
}

describe("Perpl candles", () => {
  test("backtests of different lengths and starts share pages on a fixed grid", async () => {
    const { service, requests } = setup();
    const week = await service.candles(BTC, NOW - 7 * 86_400, NOW);
    expect(week.resolutionSec).toBe(300);
    expect(week.candles[0]!.t).toBeGreaterThanOrEqual(NOW - 7 * 86_400);
    expect(week.candles.at(-1)!.t).toBeLessThanOrEqual(NOW);
    expect(week.candles.length).toBe(7 * 288);
    // Pages start on multiples of 300,000 seconds, whatever the window; the one still filling in ends now.
    expect(requests.every((r) => r.from % PAGE === 0 && (r.to - r.from === PAGE || r.to === NOW))).toBe(true);
    expect(requests.filter((r) => r.to === NOW)).toHaveLength(1);
    const fetched = requests.length;
    // A shorter backtest a second later, and two at once, read nothing new.
    await service.candles(BTC, NOW + 1 - 86_400, NOW + 1);
    await Promise.all([service.candles(BTC, NOW - 3 * 86_400, NOW), service.candles(BTC, NOW - 5 * 86_400, NOW)]);
    expect(requests.length).toBe(fetched);
  });

  test("the page still filling in is read again after a minute, past pages after fifteen", async () => {
    const { service, requests, advance } = setup();
    await service.candles(BTC, NOW - 7 * 86_400, NOW);
    const pages = requests.length;
    expect(pages).toBe(3);
    // Five minutes on: past the live page's minute, inside the past pages' fifteen.
    advance(5 * 60_000);
    const later = await service.candles(BTC, NOW - 7 * 86_400 + 300, NOW + 300);
    // Only the current page was read again, and it has the candle that opened since.
    expect(requests.length).toBe(pages + 1);
    expect(requests.at(-1)!.from).toBe(Math.floor(NOW / PAGE) * PAGE);
    expect(later.candles.at(-1)!.t).toBe(NOW - (NOW % 300) + 300);
    advance(PAST_CANDLE_PAGE_MS);
    await service.candles(BTC, NOW - 7 * 86_400, NOW);
    expect(requests.length).toBe(pages + 1 + pages);
  });

  test("a failed read is not kept", async () => {
    const { service, requests, failNext } = setup();
    failNext(true);
    await expect(service.candles(BTC, NOW - 86_400, NOW)).rejects.toThrow("HTTP 503");
    failNext(false);
    const ok = await service.candles(BTC, NOW - 86_400, NOW);
    expect(ok.candles.length).toBe(288);
    expect(requests.length).toBe(2);
  });
});
