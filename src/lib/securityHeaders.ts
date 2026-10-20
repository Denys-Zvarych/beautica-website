// Security headers (README D8). Single source for the Worker middleware; `public/_headers` carries the same values for
// static assets (Cloudflare applies _headers to assets only, never to Worker responses). Keep the two in sync.
// No analytics origin yet: the zone injects no Cloudflare Web Analytics beacon (checked on the live site, 2026-10-19).
// When Umami / CF Web Analytics / Turnstile ship, extend script-src, connect-src, frame-src here AND in public/_headers.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // inlineStylesheets: "always"
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};

// Applied to every on-demand response, including error answers: it never overrides a header a route already set
// (token routes set their own Referrer-Policy: no-referrer).
export function withSecurityHeaders(res: Response): Response {
  let out = res;
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  } catch {
    // Immutable headers (e.g. a redirect Response): copy, then set.
    out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  }
  return out;
}
