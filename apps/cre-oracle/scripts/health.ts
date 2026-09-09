/**
 * The loop's HTTP endpoints, served when PORT is set (a platform such as Railway):
 *   GET /live    200 while the process runs; the platform's deploy check.
 *   GET /health  200 while runs succeed: one finished within the last three intervals (or the loop
 *                started less than three intervals ago) and fewer than three failed in a row.
 */
export interface LoopState {
  startedAt: number;
  /** When the last run that reported or found nothing to report finished. */
  lastOkAt: number | null;
  /** Failed runs in a row. */
  failures: number;
}

export function healthHandler(state: () => LoopState, everySec: number, now: () => number = Date.now) {
  return (req: Request): Response => {
    const path = new URL(req.url).pathname;
    if (path === "/live") return Response.json({ live: true });
    if (path === "/health") {
      const s = state();
      const window = 3 * everySec * 1000;
      const fresh = now() - (s.lastOkAt ?? s.startedAt) < window;
      const ok = fresh && s.failures < 3;
      const lastOkAt = s.lastOkAt === null ? null : new Date(s.lastOkAt).toISOString();
      return Response.json({ ok, everySec, lastOkAt, failures: s.failures }, { status: ok ? 200 : 503 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}
