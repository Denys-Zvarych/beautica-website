// Security headers (README D8). Single source for the Worker middleware; `public/_headers` carries the same values for
// static assets (Cloudflare applies _headers to assets only, never to Worker responses). Keep the two in sync.
// Analytics (phase 007): script-src cloud.umami.is (script.js) + static.cloudflareinsights.com (beacon); connect-src gateway.umami.is
// (where script.js POSTs /api/send) + cloudflareinsights.com (beacon reports). Token routes never load the tags and get TOKEN_CSP (no analytics origins); the other routes allow them. Origins
// mirror src/config/analytics.mjs (tests/static-build.test.mjs checks). Keep public/_headers in sync.
// Turnstile + the runtime API origin are added per page by bookingCsp() below (the SSR link pages only).
const ANALYTICS_SCRIPT = "https://cloud.umami.is/script.js https://static.cloudflareinsights.com/beacon.min.js";
const ANALYTICS_CONNECT = "https://gateway.umami.is/api/send https://cloudflareinsights.com/cdn-cgi/rum";

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cloud.umami.is/script.js https://static.cloudflareinsights.com/beacon.min.js",
  "style-src 'self' 'unsafe-inline'", // inlineStylesheets: "always"
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.beautica.app https://gateway.umami.is/api/send https://cloudflareinsights.com/cdn-cgi/rum", // guest cancel page (phase 004); keep in sync with public/_headers
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

/** Token routes (/l/*, /invite/*, /bookings/*, /book/cancel/*) never load analytics: the shared policy minus its origins. public/_headers carries the same value. */
export const TOKEN_CSP = CSP.replace(` ${ANALYTICS_SCRIPT}`, "").replace(` ${ANALYTICS_CONNECT}`, "");

const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * CSP of the SSR booking-link pages (/book/{slug}, /book/s/{slug}): the base policy plus the runtime API origin (booking calls),
 * the image origins actually present in the API data (R2 media), and Cloudflare Turnstile only when a site key is configured.
 * Set by the page itself (the middleware never overrides a header a route already set).
 */
export function bookingCsp(opts: { apiOrigin: string; imgOrigins: string[]; turnstile: boolean }): string {
  const img = ["'self'", "data:", ...new Set(opts.imgOrigins)].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' ${ANALYTICS_SCRIPT}${opts.turnstile ? ` ${TURNSTILE}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img}`,
    "font-src 'self'",
    `connect-src 'self' ${opts.apiOrigin} ${ANALYTICS_CONNECT}${opts.turnstile ? ` ${TURNSTILE}` : ""}`,
    ...(opts.turnstile ? [`frame-src ${TURNSTILE}`] : []),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

// Applied to every on-demand response, including error answers: it never overrides a header a route already set
// (token routes set their own Referrer-Policy: no-referrer).
//
// `path` (the request pathname) matters for token prefixes: ANY answer under /book/cancel/, /invite/, /bookings/, /l/ (a 404 for a
// malformed variant such as /book/cancel/{token}/extra included) is treated as a token response: TOKEN_CSP (no analytics origins),
// Referrer-Policy no-referrer, no-store, noindex. The URL may hold a token, so nothing on that page may report or leak it.
export const TOKEN_PATH = /^\/(?:book\/cancel|invite|bookings|l)\//;

export function withSecurityHeaders(res: Response, path?: string): Response {
  const token = path !== undefined && TOKEN_PATH.test(path);
  const defaults: Record<string, string> = token
    ? { ...SECURITY_HEADERS, "Content-Security-Policy": TOKEN_CSP, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
    : SECURITY_HEADERS;
  const apply = (r: Response) => {
    for (const [k, v] of Object.entries(defaults)) if (!r.headers.has(k)) r.headers.set(k, v);
    if (token) {
      // The 404 of an unmatched token path can come from the asset layer with the shared headers already on it (analytics origins in the
      // CSP, the default referrer policy, a cacheable answer): those are replaced; a route's own TOKEN_CSP (API origin swapped) is kept.
      r.headers.set("Content-Security-Policy", (r.headers.get("Content-Security-Policy") ?? TOKEN_CSP).replace(` ${ANALYTICS_SCRIPT}`, "").replace(` ${ANALYTICS_CONNECT}`, ""));
      r.headers.set("Referrer-Policy", "no-referrer");
      r.headers.set("Cache-Control", "no-store");
      r.headers.set("X-Robots-Tag", "noindex, nofollow");
    }
  };
  let out = res;
  try {
    apply(out);
  } catch {
    // Immutable headers (e.g. a redirect Response): copy, then set.
    out = new Response(res.body, res);
    apply(out);
  }
  return out;
}
