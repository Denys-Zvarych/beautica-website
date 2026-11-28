// Response plumbing shared by the two SSR link pages: status, robots header, cache policy, CSP.
import { bookingCsp } from "../securityHeaders.ts";
import type { BookingConfig } from "./config";

interface Res {
  status?: number;
  statusText?: string;
  headers: Headers;
}

export const NOINDEX = "noindex, nofollow";

/** Origins of the https image URLs present in the page data (R2 media), for CSP img-src. With `allowed` (imgOriginsFor) only the pinned media origin(s) survive. */
export function imageOrigins(urls: (string | null | undefined)[], allowed?: readonly string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const url = new URL(u);
      if (url.protocol === "https:" && (!allowed || allowed.includes(url.origin))) out.add(url.origin);
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

/** A page the visitor can use: indexable, edge-cached for the upstream s-maxage (the backend bounds staleness at 30 s). */
export function okResponse(res: Res, cfg: BookingConfig, ttl: number, imgOrigins: string[], opts: { noindex?: boolean; noindexFollow?: boolean } = {}): void {
  res.headers.set("Cache-Control", `public, max-age=0, s-maxage=${ttl}`);
  res.headers.set("Content-Security-Policy", bookingCsp({ apiOrigin: cfg.apiOrigin, imgOrigins, turnstile: cfg.turnstileSiteKey !== "" }));
  if (opts.noindex) res.headers.set("X-Robots-Tag", NOINDEX);
  else if (opts.noindexFollow) res.headers.set("X-Robots-Tag", "noindex, follow");
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
