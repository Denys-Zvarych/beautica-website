// Parser of GET /service-categories/approved for the icon lookup (W050). Only https URLs that are safe inside an unquoted CSS url() survive.
import type { CategoryIcons } from "../categoryIcon";
import { safeImageUrl } from "./types.ts";

const UNSAFE_IN_CSS_URL = /[\s"'()\\]/;

/** A URL is kept only when it is https, safe in an unquoted css url() and (when `allowed` is given) on a pinned media origin. */
function acceptIcon(v: unknown, allowed: readonly string[] | undefined): string | null {
  const url = safeImageUrl(v);
  if (!url || UNSAFE_IN_CSS_URL.test(url)) return null;
  if (allowed && !allowed.includes(new URL(url).origin)) return null;
  return url;
}

export function parseCategoryIcons(raw: unknown, allowed?: readonly string[]): CategoryIcons | null {
  const data = typeof raw === "object" && raw !== null ? (raw as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return null;
  const out: Record<string, string> = {};
  for (const c of data) {
    if (typeof c !== "object" || c === null) continue;
    const { name, displayName, iconUrl } = c as Record<string, unknown>;
    const url = acceptIcon(iconUrl, allowed);
    if (!url) continue;
    for (const k of [name, displayName]) if (typeof k === "string" && k.trim()) out[k.trim().toLowerCase()] ??= url;
  }
  return Object.freeze(out);
}

/** Image origins of the icon URLs, for CSP img-src (same mechanism as photos). */
export const iconUrls = (icons: CategoryIcons): string[] => [...new Set(Object.values(icons))];

/** A map read back from the cache is re-validated with the parser's own rules (and the current pin); anything off is dropped. */
function revalidate(raw: unknown, allowed: readonly string[] | undefined): CategoryIcons | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const url = acceptIcon(v, allowed);
    if (url) out[k] = url;
  }
  return Object.keys(out).length === 0 && Object.keys(raw).length > 0 ? null : Object.freeze(out); // everything dropped = a miss (the pin may have changed)
}

// --- Stale-while-revalidate icon lookup (W050). The icons are decoration: they must never delay or fail a page render, so the icons
// call is never on the TTFB path: memo / edge cache if present, else the bundled icons now and a background refresh. ---
export const ICONS_TTL_S = 300;
const NEGATIVE_TTL_S = 30;
/** The refresh runs in waitUntil, off the TTFB path: a cold connection gets a long cap, and a timeout is retried soon. */
export const ICONS_BACKGROUND_TIMEOUT_MS = 3000;
const TIMEOUT_NEGATIVE_TTL_S = 8;
const memo = new Map<string, { icons: CategoryIcons; exp: number }>();
type EdgeCache = Pick<Cache, "match" | "put">;
const edgeCache = (): EdgeCache | undefined => (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;

/** Test hook: forget the in-isolate memo. */
export const resetIconCache = (): void => memo.clear();

/** Synthetic Cache API key on OUR host (never the real API URL, which direct callers of the API could otherwise be served from). */
export function iconsCacheKey(self: string, apiOrigin: string): Request {
  let h = 2166136261;
  for (let i = 0; i < apiOrigin.length; i++) h = Math.imul(h ^ apiOrigin.charCodeAt(i), 16777619);
  return new Request(`${self}/__cache/category-icons?o=${(h >>> 0).toString(36)}`, { method: "GET" });
}

export interface IconsOpts {
  cache?: EdgeCache | null;
  now?: () => number;
  timeoutMs?: number;
  /** The request's own origin: the Cache API key lives there. Without it the edge cache is skipped. */
  self?: string;
  /** Pinned image origins (imgOriginsFor); applied again on every cache read. */
  allowed?: readonly string[];
  /** ctx.waitUntil: keeps the background refresh alive after the response is sent. */
  waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * Icons for `apiOrigin`, never awaiting the icons call: fresh isolate memo -> (stale memo, refresh in background) -> Workers Cache API
 * (5 min, synthetic key, re-validated) -> {} (bundled icons) with the refresh in the background. The background fetch has a 3 s cap (never awaited);
 * a failure is remembered for 30 s (8 s after a timeout) so a slow backend costs one fetch per window, not one per render.
 */
export async function cachedCategoryIcons(apiOrigin: string, load: (timeoutMs: number) => Promise<CategoryIcons | null>, opts: IconsOpts = {}): Promise<CategoryIcons> {
  const now = opts.now ?? Date.now;
  const hit = memo.get(apiOrigin);
  if (hit && hit.exp > now()) return hit.icons;
  const cache = opts.self ? (opts.cache === undefined ? edgeCache() : opts.cache ?? undefined) : undefined;
  const key = cache && opts.self ? iconsCacheKey(opts.self, apiOrigin) : null;
  if (!hit && cache && key) {
    try {
      const stored = await cache.match(key);
      const icons = stored ? revalidate(await stored.json(), opts.allowed) : null;
      if (icons) {
        memo.set(apiOrigin, { icons, exp: now() + ICONS_TTL_S * 1000 });
        return icons;
      }
    } catch {
      /* a broken cache entry = a miss */
    }
  }
  const prev = hit?.icons ?? {};
  memo.set(apiOrigin, { icons: prev, exp: now() + NEGATIVE_TTL_S * 1000 }); // one refresh per window, whatever the outcome
  const ms = opts.timeoutMs ?? ICONS_BACKGROUND_TIMEOUT_MS;
  const refresh = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = await Promise.race([
      load(ms).catch(() => null),
      new Promise<null>((res) => (timer = setTimeout(() => res(null), ms))), // belt and braces: a fetch that ignores its abort signal
    ]);
    clearTimeout(timer);
    if (!loaded) {
      memo.set(apiOrigin, { icons: prev, exp: now() + TIMEOUT_NEGATIVE_TTL_S * 1000 }); // a cold connection: retry soon, bundled icons meanwhile
      return;
    }
    memo.set(apiOrigin, { icons: loaded, exp: now() + ICONS_TTL_S * 1000 });
    if (cache && key) await cache.put(key, new Response(JSON.stringify(loaded), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ICONS_TTL_S}` } }));
  })().catch(() => undefined);
  opts.waitUntil?.(refresh);
  return prev;
}
