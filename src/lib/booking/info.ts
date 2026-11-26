// Server-side loaders for GET /api/v1/book/{slug}/info and /book/s/{slug}/info (backend phases 377/380).
// Sends the optional Worker key + the visitor IP so the backend's per-IP limit keys on the real visitor, never the Worker.
import { parseMasterInfo, parseReviewsPage, parseSalonInfo, type MasterInfo, type ReviewItem, type SalonInfo } from "./types";
import type { BookingConfig } from "./config";
import { upstreamTtl } from "./cache";
import { cachedCategoryIcons, parseCategoryIcons } from "./icons";
import type { CategoryIcons } from "../categoryIcon";
import { imgOriginsFor } from "../mediaOrigin";

export type InfoResult<T> =
  | { kind: "ok"; data: T; ttl: number }
  | { kind: "not-found" }
  | { kind: "gone" }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "unavailable"; retryAfter: number };

const TIMEOUT_MS = 5000;

async function get<T>(cfg: BookingConfig, path: string, ip: string | undefined, parse: (raw: unknown) => T | null, timeoutMs = TIMEOUT_MS, anonymous = false): Promise<InfoResult<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.workerKey && !anonymous) {
    headers["X-Beautica-Worker-Key"] = cfg.workerKey;
    if (ip) headers["X-Beautica-Client-IP"] = ip; // CF-Connecting-IP is dropped on a Workers subrequest; the backend reads this one on worker-key requests only
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.apiOrigin}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { kind: "unavailable", retryAfter: 30 };
  }
  if (res.status === 404 || res.status === 400) return { kind: "not-found" };
  if (res.status === 410) return { kind: "gone" };
  const retryAfter = Math.min(300, Math.max(1, Number(res.headers.get("Retry-After")) || 30));
  if (res.status === 429) return { kind: "rate-limited", retryAfter };
  if (!res.ok) return { kind: "unavailable", retryAfter };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { kind: "unavailable", retryAfter: 30 };
  }
  const data = parse(json);
  return data ? { kind: "ok", data, ttl: upstreamTtl(res.headers.get("Cache-Control")) } : { kind: "unavailable", retryAfter: 30 };
}

export const fetchMasterInfo = (cfg: BookingConfig, slug: string, ip?: string): Promise<InfoResult<MasterInfo>> =>
  get(cfg, `/api/v1/book/${encodeURIComponent(slug)}/info`, ip, (raw) => parseMasterInfo(slug, raw));

export const fetchSalonInfo = (cfg: BookingConfig, slug: string, ip?: string): Promise<InfoResult<SalonInfo>> =>
  get(cfg, `/api/v1/book/s/${encodeURIComponent(slug)}/info`, ip, (raw) => parseSalonInfo(slug, raw));

/** Page 0 (5 reviews) of GET /book/{slug}/reviews or /book/s/{slug}/reviews: the first view of a non-default sort (the ?sort= link without script). */
export async function fetchReviewsFirstPage(cfg: BookingConfig, kind: "master" | "salon", slug: string, sort: string, ip?: string): Promise<ReviewItem[] | null> {
  const r = await get(cfg, `/api/v1/book/${kind === "salon" ? "s/" : ""}${encodeURIComponent(slug)}/reviews?sort=${encodeURIComponent(sort)}&page=0&size=5`, ip, parseReviewsPage);
  return r.kind === "ok" ? r.data.items : null;
}

/**
 * GET /service-categories/approved -> icon lookup (W050), stale-while-revalidate: never awaited on the render path (see cachedCategoryIcons). The call is
 * anonymous and shared (no worker key, no visitor IP: one cached answer serves everyone), keeps its 700 ms cap and pins icon URLs to the media origin.
 */
export const fetchCategoryIcons = (cfg: BookingConfig, ctx: { self: string; waitUntil?: (p: Promise<unknown>) => void }): Promise<CategoryIcons> => {
  const allowed = imgOriginsFor(cfg);
  return cachedCategoryIcons(
    cfg.apiOrigin,
    async (ms) => {
      const r = await get(cfg, "/api/v1/service-categories/approved", undefined, (raw) => parseCategoryIcons(raw, allowed), ms, true);
      return r.kind === "ok" ? r.data : null;
    },
    { self: ctx.self, allowed, waitUntil: ctx.waitUntil },
  );
};
