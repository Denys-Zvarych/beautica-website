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
  /** Pinned image origin of category icons (MEDIA_ORIGIN, default prod media host). */
  mediaOrigin?: string;
}

import { normalizeMediaOrigin } from "../mediaOrigin.ts";

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

type Parsed = { cfg: AdminConfig } | { problem: string };

function parse(e: Record<string, unknown>): Parsed {
  const teamDomain = str(e.CF_ACCESS_TEAM_DOMAIN).toLowerCase();
  const aud = str(e.CF_ACCESS_AUD);
  const emails = str(e.ADMIN_EMAILS).toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const catalogKey = str(e.INTERNAL_CATALOG_KEY);
  const apiOrigin = strictApiOrigin(e.API_ORIGIN);
  // Same checks, same order as before; the first failing one names the problem.
  if (!TEAM.test(teamDomain)) return { problem: "CF_ACCESS_TEAM_DOMAIN" };
  if (!aud) return { problem: "CF_ACCESS_AUD" };
  if (emails.length === 0) return { problem: "ADMIN_EMAILS" };
  if (catalogKey.length < KEY_MIN) return { problem: "INTERNAL_CATALOG_KEY" };
  if (!apiOrigin) return { problem: "API_ORIGIN" };
  return { cfg: { teamDomain, aud, emails, catalogKey, apiOrigin, mediaOrigin: normalizeMediaOrigin(e.MEDIA_ORIGIN) } };
}

/** One parse: the config, or null plus the NAME of the first failing env field (never a value). */
export function adminConfigResolve(e: Record<string, unknown>): { config: AdminConfig | null; problem: string | null } {
  const r = parse(e);
  return "cfg" in r ? { config: r.cfg, problem: null } : { config: null, problem: r.problem };
}

export function adminConfigFrom(e: Record<string, unknown>): AdminConfig | null {
  const r = parse(e);
  return "cfg" in r ? r.cfg : null;
}

/** The NAME of the first invalid/missing env field (never a value), or null when the config is valid. For the denial log only. */
export function adminConfigProblem(e: Record<string, unknown>): string | null {
  const r = parse(e);
  return "problem" in r ? r.problem : null;
}
