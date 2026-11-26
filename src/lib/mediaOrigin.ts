// Pure (node-testable) media-origin helpers shared by the booking pages and /admin.
export const PROD_MEDIA = "https://media.beautica.app";

/** Origin only, https only; anything else falls back to the prod media host. */
export function normalizeMediaOrigin(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return PROD_MEDIA;
  try {
    const u = new URL(raw.trim());
    if (u.protocol === "https:") return u.origin;
  } catch {
    /* fall through */
  }
  return PROD_MEDIA;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The only origins an image URL from API data may come from: the configured media origin, plus the API origin itself when that is loopback
 * (local harness / tests). A production CSP never carries a loopback or arbitrary origin.
 */
export function imgOriginsFor(c: { apiOrigin: string; mediaOrigin?: string }): string[] {
  const out: string[] = c.mediaOrigin ? [c.mediaOrigin] : [];
  try {
    if (LOOPBACK.has(new URL(c.apiOrigin).hostname)) out.push(new URL(c.apiOrigin).origin);
  } catch {
    /* no api origin */
  }
  return out;
}
