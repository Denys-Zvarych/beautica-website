// Runtime (Worker) config of the private /admin area (phase 039). Pure: takes the env record, so it is unit-testable in node.
// Per environment (prod = vars/secrets, staging = previews.vars / previews secrets); nothing here is hard-coded per env:
//   CF_ACCESS_TEAM_DOMAIN  Zero Trust team domain, `<team>.cloudflareaccess.com` (same org for prod and staging)
//   CF_ACCESS_AUD          AUD tag of THIS environment's Access application (prod and staging have different ones)
//   ADMIN_EMAILS           comma-separated owner emails allowed in
//   INTERNAL_CATALOG_KEY   secret (>= 32 chars, like the backend guard): catalog-scoped backend key (B501), never the master INTERNAL_API_KEY
//   API_ORIGIN             backend origin (shared with the booking pages; staging overrides it in previews.vars); required and strict here
// Any missing or malformed value yields null: /admin is then disabled (404), never half-open.

export interface AdminConfig {
  teamDomain: string;
  aud: string;
  emails: string[];
  catalogKey: string;
  apiOrigin: string;
}

const TEAM = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const KEY_MIN = 32;

/** Strict backend origin: https (http only for loopback). Missing or invalid -> null. NO prod fallback (unlike the booking pages): a broken
 *  staging config must never send the staging catalog key to the prod API. */
export function strictApiOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const u = new URL(raw.trim());
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return u.protocol === "https:" || (u.protocol === "http:" && loopback) ? u.origin : null;
  } catch {
    return null;
  }
}

export function adminConfigFrom(e: Record<string, unknown>): AdminConfig | null {
  const teamDomain = str(e.CF_ACCESS_TEAM_DOMAIN).toLowerCase();
  const aud = str(e.CF_ACCESS_AUD);
  const emails = str(e.ADMIN_EMAILS).toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const catalogKey = str(e.INTERNAL_CATALOG_KEY);
  const apiOrigin = strictApiOrigin(e.API_ORIGIN);
  if (!TEAM.test(teamDomain) || !aud || emails.length === 0 || catalogKey.length < KEY_MIN || !apiOrigin) return null;
  return { teamDomain, aud, emails, catalogKey, apiOrigin };
}
