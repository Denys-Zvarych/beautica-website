// Server-side loaders for GET /api/v1/book/{slug}/info and /book/s/{slug}/info (backend phases 377/380).
// Sends the optional Worker key + the visitor IP so the backend's per-IP limit keys on the real visitor, never the Worker.
import { parseMasterInfo, parseSalonInfo, type MasterInfo, type SalonInfo } from "./types";
import type { BookingConfig } from "./config";
import { upstreamTtl } from "./cache";

export type InfoResult<T> =
  | { kind: "ok"; data: T; ttl: number }
  | { kind: "not-found" }
  | { kind: "gone" }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "unavailable"; retryAfter: number };

const TIMEOUT_MS = 5000;

async function get<T>(cfg: BookingConfig, path: string, ip: string | undefined, parse: (raw: unknown) => T | null): Promise<InfoResult<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cfg.workerKey) headers["X-Beautica-Worker-Key"] = cfg.workerKey;
  if (ip) headers["CF-Connecting-IP"] = ip;
  let res: Response;
  try {
    res = await fetch(`${cfg.apiOrigin}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
  get(cfg, `/api/v1/book/${slug}/info`, ip, (raw) => parseMasterInfo(slug, raw));

export const fetchSalonInfo = (cfg: BookingConfig, slug: string, ip?: string): Promise<InfoResult<SalonInfo>> =>
  get(cfg, `/api/v1/book/s/${slug}/info`, ip, (raw) => parseSalonInfo(slug, raw));
