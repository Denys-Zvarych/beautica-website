// Response plumbing shared by the two SSR link pages: status, robots header, cache policy, CSP.
import { bookingCsp } from "../securityHeaders";
import type { BookingConfig } from "./config";

interface Res {
  status?: number;
  statusText?: string;
  headers: Headers;
}

export const NOINDEX = "noindex, nofollow";

/** Origins of the https image URLs present in the page data (R2 media), for CSP img-src. */
export function imageOrigins(urls: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const url = new URL(u);
      if (url.protocol === "https:") out.add(url.origin);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

/** A page the visitor can use: indexable, edge-cached for the upstream s-maxage (the backend bounds staleness at 30 s). */
export function okResponse(res: Res, cfg: BookingConfig, ttl: number, imgOrigins: string[], opts: { noindex?: boolean } = {}): void {
  res.headers.set("Cache-Control", `public, max-age=0, s-maxage=${ttl}`);
  res.headers.set("Content-Security-Policy", bookingCsp({ apiOrigin: cfg.apiOrigin, imgOrigins, turnstile: cfg.turnstileSiteKey !== "" }));
  if (opts.noindex) res.headers.set("X-Robots-Tag", NOINDEX);
}

/** Any non-profile state: never cached, never indexed. */
const STATUS_TEXT: Record<number, string> = { 200: "OK", 404: "Not Found", 410: "Gone", 429: "Too Many Requests", 503: "Service Unavailable" };
export function noticeResponse(res: Res, status: number, retryAfter?: number): void {
  res.status = status;
  res.statusText = STATUS_TEXT[status] ?? "";
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", NOINDEX);
  if (retryAfter !== undefined) res.headers.set("Retry-After", String(retryAfter));
}
