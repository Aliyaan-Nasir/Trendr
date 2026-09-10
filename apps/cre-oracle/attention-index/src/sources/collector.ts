import type { HttpRequest } from "../http";

/**
 * The backend collector (backend/src/collector.ts): the latest reading per source for each trend,
 * gathered at a pace free API budgets sustain. Readings are keyed by base identifier (`topic:x`
 * for `topic:x.2`).
 */

export type CollectedSource = "elfa" | "gdelt" | "nansen" | "wikipedia" | "bluesky" | "hn";

export interface Reading {
  value: number;
  observedAt: number;
}

export interface Collected {
  article: string | null;
  readings: Partial<Record<CollectedSource, Reading>>;
}

const SOURCES: readonly CollectedSource[] = ["elfa", "gdelt", "nansen", "wikipedia", "bluesky", "hn"];

export function measurementsRequest(url: string, token: string, identifiers: readonly string[]): HttpRequest {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const ids = [...new Set(identifiers)].sort().map(encodeURIComponent).join(",");
  return { url: `${url}${url.includes("?") ? "&" : "?"}ids=${ids}`, method: "GET", headers };
}

/** Parses `{ trends: { [identifier]: { article, readings: { [source]: { value, observedAt } | null } } } }`. */
export function parseMeasurements(body: string): Map<string, Collected> {
  const json = JSON.parse(body) as { trends?: Record<string, { article?: unknown; readings?: Record<string, unknown> }> };
  if (!json.trends || typeof json.trends !== "object") throw new Error("collector: malformed response");
  const out = new Map<string, Collected>();
  for (const [identifier, t] of Object.entries(json.trends)) {
    const readings: Collected["readings"] = {};
    for (const s of SOURCES) {
      const r = t.readings?.[s] as { value?: unknown; observedAt?: unknown } | null | undefined;
      if (!r || typeof r.value !== "number" || !Number.isFinite(r.value) || typeof r.observedAt !== "number") continue;
      readings[s] = { value: r.value, observedAt: r.observedAt };
    }
    out.set(identifier, { article: typeof t.article === "string" && t.article.length > 0 ? t.article : null, readings });
  }
  return out;
}

/** A reading no older than `maxAgeSec` at `atSec`, else null. */
export function fresh(r: Reading | undefined, atSec: number, maxAgeSec: number): number | null {
  if (!r || atSec - r.observedAt > maxAgeSec) return null;
  return r.value;
}
