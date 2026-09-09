import { describe, expect, test } from "bun:test";
import { healthHandler, type LoopState } from "./health";

const T = 1_800_000_000_000;
const get = (handler: (req: Request) => Response, path: string) => handler(new Request(`http://loop${path}`));

describe("loop health", () => {
  test("/live answers whatever the runs do", async () => {
    const failing = healthHandler(() => ({ startedAt: T, lastOkAt: null, failures: 9 }), 60, () => T + 3_600_000);
    const res = get(failing, "/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
    expect(get(failing, "/health").status).toBe(503);
    expect(get(failing, "/nope").status).toBe(404);
  });

  test("/health gives a new loop three intervals, then needs a recent successful run", async () => {
    let state: LoopState = { startedAt: T, lastOkAt: null, failures: 0 };
    let now = T + 170_000;
    const handler = healthHandler(() => state, 60, () => now);
    expect(get(handler, "/health").status).toBe(200);
    now = T + 181_000;
    expect(get(handler, "/health").status).toBe(503);
    state = { ...state, lastOkAt: T + 150_000 };
    const res = get(handler, "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, everySec: 60, lastOkAt: new Date(T + 150_000).toISOString(), failures: 0 });
  });

  test("/health turns red after three failed runs in a row, even with a recent success", () => {
    const handler = healthHandler(() => ({ startedAt: T, lastOkAt: T, failures: 3 }), 60, () => T + 1_000);
    expect(get(handler, "/health").status).toBe(503);
  });
});
