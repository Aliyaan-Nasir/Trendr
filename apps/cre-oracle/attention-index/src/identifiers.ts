/**
 * Trend identifiers: lowercase `[a-z0-9:._-]`, 1 to 64 bytes, conventionally `<class>:<slug>`
 * (for example `topic:hantavirus`, `crypto:mon`). The registry makes identifiers permanent, so a
 * trend that retires and later returns is listed again as `<base>.<n>` (n = 2, 3, ...).
 */

export const MAX_IDENTIFIER_LENGTH = 64;
export const MAX_VERSION = 9;
const IDENTIFIER_RE = /^[a-z0-9:._-]{1,64}$/;
const VERSION_RE = /\.([2-9])$/;

/** Asset classes in TrendRegistry order. */
export const ASSET_CLASSES = ["crypto", "equity", "commodity", "fx", "person", "politics", "topic"] as const;
export const CRYPTO = 0;
export const TOPIC = 6;

export function isNormalized(identifier: string): boolean {
  return IDENTIFIER_RE.test(identifier);
}

/** Normalizes free text into an identifier, or returns null when nothing usable is left. */
export function normalizeIdentifier(raw: string): string | null {
  const out = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_IDENTIFIER_LENGTH);
  return isNormalized(out) ? out : null;
}

export function baseOf(identifier: string): string {
  return identifier.replace(VERSION_RE, "");
}

/** The `n`th listing of `base`: the base itself for n = 1, otherwise `<base>.<n>`. */
export function versioned(base: string, n: number): string | null {
  if (n === 1) return base;
  const id = `${base}.${n}`;
  return id.length <= MAX_IDENTIFIER_LENGTH ? id : null;
}

export function assetClassOf(identifier: string): number {
  const prefix = identifier.split(":")[0] ?? "";
  const i = (ASSET_CLASSES as readonly string[]).indexOf(prefix);
  return identifier.includes(":") && i >= 0 ? i : TOPIC;
}

function slugOf(identifier: string): string {
  const base = baseOf(identifier);
  const colon = base.indexOf(":");
  return colon >= 0 ? base.slice(colon + 1) : base;
}

/** Ticker for crypto and equity trends (`crypto:mon` gives `MON`), otherwise null. */
export function tickerOf(identifier: string): string | null {
  const cls = assetClassOf(identifier);
  if (cls !== CRYPTO && cls !== 1) return null;
  const slug = slugOf(identifier);
  return /^[a-z0-9]{1,15}$/.test(slug) ? slug.toUpperCase() : null;
}

/**
 * Search keywords for an identifier: an explicit override, else the cashtag for tickers, else
 * the slug's words.
 */
export function keywordsFor(identifier: string, overrides: Record<string, string[]>): string[] {
  const base = baseOf(identifier);
  const override = overrides[base];
  if (override) return override;
  const ticker = tickerOf(identifier);
  if (ticker) return [`$${ticker}`];
  return [slugOf(identifier).replace(/[-_.:]+/g, " ").trim()];
}

const PERSON = 4;

/**
 * Wikipedia article for an identifier: an explicit override, else the first keyword with
 * underscores, capitalized as Wikipedia titles are (every word for people, the first letter
 * otherwise). Pageview counts do not follow redirects, so the exact title matters. Tickers get no
 * derived article, since a cashtag is not a title.
 */
export function articleFor(identifier: string, keywords: readonly string[], overrides: Record<string, string>): string | null {
  const override = overrides[baseOf(identifier)];
  if (override) return override;
  if (tickerOf(identifier)) return null;
  const first = keywords[0]?.trim();
  if (!first || first.startsWith("$")) return null;
  const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const everyWord = assetClassOf(identifier) === PERSON;
  return first
    .split(/\s+/)
    .map((w, i) => (i === 0 || everyWord ? capitalize(w) : w))
    .join("_");
}
