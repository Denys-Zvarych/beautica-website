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

/** Token routes (/l/*, /invite/*, /bookings/*, /book/cancel/*, /c/*, /r/*) never load analytics: the shared policy minus its origins. public/_headers carries the same value. */
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

/**
 * CSP of the guest review page /r/{token} (phase 019): a token route, so the base policy WITHOUT analytics origins, plus the runtime API
 * origin (submit / opt-out), the avatar's image origin and Turnstile only when a site key is configured. Set by the page itself.
 */
export function reviewCsp(opts: { apiOrigin: string; imgOrigins: string[]; turnstile: boolean }): string {
  const img = ["'self'", "data:", ...new Set(opts.imgOrigins)].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self'${opts.turnstile ? ` ${TURNSTILE}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${img}`,
    "font-src 'self'",
    `connect-src 'self' ${opts.apiOrigin}${opts.turnstile ? ` ${TURNSTILE}` : ""}`,
    ...(opts.turnstile ? [`frame-src ${TURNSTILE}`] : []),
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** /admin* (phase 039): no script, no connections, no analytics. `style-src 'unsafe-inline'` is needed because Astro inlines every stylesheet (inlineStylesheets: "always"); with no script-src at all there is no script to abuse it. public/_headers carries the same value. */
export const ADMIN_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const ADMIN_PATH = /^\/admin(?:\/|$)/;
/**
 * Is this request pathname under /admin? Astro routes on the DECODED path, so the raw pathname is not enough: `/%61dmin`, `/%41dmin`, `/admin%2fx`
 * all reach the admin routes. ASCII percent-escapes are decoded (and lower-cased) before the test; a malformed escape never throws and never
 * hides a match. `malformed` = the path would match /admin but is not valid percent-encoding: the caller answers 404 itself (fail closed).
 */
export function adminPath(pathname: string): { admin: boolean; malformed: boolean } {
  let malformed = false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    malformed = true;
    decoded = pathname.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
  const lower = decoded.toLowerCase();
  // Malformed: be strict (prefix only), the escape may be hiding the boundary (`/admin%zz`).
  const admin = malformed ? /^\/admin/.test(lower) : ADMIN_PATH.test(lower);
  return { admin, malformed: admin && malformed };
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
// `path` (the request pathname) matters for token prefixes: ANY answer under /book/cancel/, /c/, /invite/, /bookings/, /l/, /r/ (a 404 for a
// malformed variant such as /book/cancel/{token}/extra included) is treated as a token response: TOKEN_CSP (no analytics origins),
// Referrer-Policy no-referrer, no-store, noindex. The URL may hold a token, so nothing on that page may report or leak it.
// /api/ics carries the cancel token in its query (?c=): same Referrer-Policy no-referrer rule; its other headers are the route's own.
export const REFERRER_NONE_PATH = /^\/api\/ics$/;
export const TOKEN_PATH = /^\/(?:book\/cancel|c|invite|bookings|l|r)\//;

export function withSecurityHeaders(res: Response, path?: string): Response {
  if (path !== undefined && adminPath(path).admin) {
    // Private operator area: always these values, even over a route's own (nothing under /admin may be cached or indexed).
    // Referrer-Policy is same-origin, NOT no-referrer: under no-referrer a browser sends `Origin: null` on every POST (Fetch spec), which the CSRF check in middleware.ts rejects;
    // same-origin keeps the real Origin on same-origin form posts and still sends no referrer to any other site.
    const force = { ...SECURITY_HEADERS, "Content-Security-Policy": ADMIN_CSP, "Referrer-Policy": "same-origin", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
    const set = (r: Response) => { for (const [k, v] of Object.entries(force)) r.headers.set(k, v); };
    try { set(res); return res; } catch { const out = new Response(res.body, res); set(out); return out; }
  }
  const token = path !== undefined && TOKEN_PATH.test(path);
  const noReferrer = token || (path !== undefined && REFERRER_NONE_PATH.test(path));
  const defaults: Record<string, string> = token
    ? { ...SECURITY_HEADERS, "Content-Security-Policy": TOKEN_CSP, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
    : noReferrer
      ? { ...SECURITY_HEADERS, "Referrer-Policy": "no-referrer" }
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
