/**
 * The backend's rotating list (`/v1/rotation`): trends being rotated out, whose index goes stale on
 * purpose. Read at most once a minute; a failed read keeps the last answer.
 */
export function rotationReader(url: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): () => Promise<ReadonlySet<string>> {
  let cached: { at: number; ids: ReadonlySet<string> } = { at: Number.NEGATIVE_INFINITY, ids: new Set() };
  return async () => {
    if (now() - cached.at < 60_000) return cached.ids;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { rotating?: unknown };
      const ids = Array.isArray(body.rotating) ? body.rotating.filter((r): r is string => typeof r === "string") : [];
      cached = { at: now(), ids: new Set(ids) };
    } catch {
      cached = { ...cached, at: now() };
    }
    return cached.ids;
  };
}
