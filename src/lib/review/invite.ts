// Guest review link /r/{token} (phase 019): the server-side read of GET /api/v1/public/review-invites/{token}.
// The token is a bearer credential: it appears only in the outbound path, never in a log line, a header the visitor sees, or a stored key.
//
// TODO(backend-401): the contract this file assumes (phase 401 + the 019 design input):
//   200 { providerName, providerType: "MASTER"|"SALON", visitDate, items: [{ bookingId, serviceName, masterName }], displayName,
//         avatarUrl?, avgRating?, reviewCount?, professionalTitle? }       the form (the last four feed the MasterStrip card; all optional)
//   200 { state: "ALREADY_REVIEWED" }                                      a consumed token: the distinct «Відгук уже надіслано» screen
//   404 (also 400)                                                         unknown / expired / flag off: ONE identical answer (no oracle)
//   429 / 5xx                                                              retry notice
// The body may come bare or wrapped as { data: ... } (ApiResponse); both are read.
import type { BookingConfig } from "../booking/config";
import { safeImageUrl } from "../booking/types";

export interface ReviewItemInfo {
  bookingId: string;
  serviceName: string;
  masterName: string | null;
}
export interface ReviewInvite {
  providerName: string;
  providerType: "MASTER" | "SALON";
  visitDate: string;
  items: ReviewItemInfo[];
  displayName: string;
  avatarUrl: string | null;
  avgRating: number | null;
  reviewCount: number;
  professionalTitle: string | null;
}
export type InviteResult =
  | { kind: "open"; data: ReviewInvite }
  | { kind: "already" }
  | { kind: "invalid" }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "unavailable"; retryAfter: number };

/** The token alphabet the page will pass to the API: URL-safe, bounded. Anything else is "invalid" without a request. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const TIMEOUT_MS = 5000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function parseInvite(raw: unknown): InviteResult | null {
  const o = isObj(raw) && isObj(raw.data) ? raw.data : raw;
  if (!isObj(o)) return null;
  if (o.state === "ALREADY_REVIEWED") return { kind: "already" };
  const providerName = str(o.providerName);
  const visitDate = str(o.visitDate);
  const displayName = str(o.displayName);
  if (!providerName || !visitDate || !displayName || !Array.isArray(o.items)) return null;
  const items = o.items.flatMap((i): ReviewItemInfo[] => {
    const bookingId = isObj(i) ? str(i.bookingId) : null;
    const serviceName = isObj(i) ? str(i.serviceName) : null;
    return bookingId && serviceName && isObj(i) ? [{ bookingId, serviceName, masterName: str(i.masterName) }] : [];
  });
  if (items.length === 0 || items.length > 20) return null;
  const rating = typeof o.avgRating === "number" && o.avgRating >= 0 && o.avgRating <= 5 ? o.avgRating : null;
  const count = typeof o.reviewCount === "number" && Number.isFinite(o.reviewCount) && o.reviewCount > 0 ? Math.floor(o.reviewCount) : 0;
  return {
    kind: "open",
    data: {
      providerName,
      providerType: o.providerType === "SALON" ? "SALON" : "MASTER",
      visitDate,
      items,
      displayName,
      avatarUrl: safeImageUrl(o.avatarUrl),
      avgRating: rating,
      reviewCount: count,
      professionalTitle: str(o.professionalTitle),
    },
  };
}

export async function fetchInvite(cfg: BookingConfig, token: string, ip?: string): Promise<InviteResult> {
  if (!TOKEN_RE.test(token)) return { kind: "invalid" };
  const headers: Record<string, string> = { Accept: "application/json" };
  // Same per-visitor limit key as the info calls (TODO(backend-401): the worker-key exemption must cover this GET too).
  // CF-Connecting-IP does not survive a Workers subrequest, so the visitor IP travels in a custom header (the backend reads it only on worker-key requests).
  if (cfg.workerKey) {
    headers["X-Beautica-Worker-Key"] = cfg.workerKey;
    if (ip) headers["X-Beautica-Client-IP"] = ip; // honoured by the backend on worker-key requests only
  }
  let res: Response;
  try {
    res = await fetch(`${cfg.apiOrigin}/api/v1/public/review-invites/${token}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { kind: "unavailable", retryAfter: 30 };
  }
  if (res.status === 404 || res.status === 400 || res.status === 410) return { kind: "invalid" };
  const retryAfter = Math.min(300, Math.max(1, Number(res.headers.get("Retry-After")) || 30));
  if (res.status === 429) return { kind: "rate-limited", retryAfter };
  if (!res.ok) return { kind: "unavailable", retryAfter };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { kind: "unavailable", retryAfter: 30 };
  }
  return parseInvite(json) ?? { kind: "unavailable", retryAfter: 30 };
}

/** «24 жовтня 2026» (Kyiv); a bare date or a datetime. */
export function formatVisitDate(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", year: "numeric" }).format(d).replace(/\s?р\.$/, "");
}
