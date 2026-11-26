// Runtime (Worker) config of the booking-link pages. Read from the Worker env, NOT from the build: staging and prod
// differ only by wrangler `vars` / `previews.vars` / dashboard variables, never by code or build flags.
//   API_ORIGIN              public API origin (https; http only for localhost). Default: prod API.
//   TURNSTILE_SITE_KEY      public Cloudflare Turnstile site key (prod: real key set in the dashboard; local/staging: test key).
//   MEDIA_ORIGIN            public R2/CDN origin of the photos (https only). Default: prod media host. The guest review page renders an avatar only from it.
//   BOOKING_INFO_WORKER_KEY secret shared with the backend: per-visitor rate limit on /book/**/info. Server-side only, never rendered.
import { env } from "cloudflare:workers";
import { PRIVACY_POLICY_VERSION } from "../../config/legal.mjs";
import { normalizeMediaOrigin } from "../mediaOrigin";
export { normalizeMediaOrigin };

const PROD_API = "https://api.beautica.app";

export interface BookingConfig {
  apiOrigin: string;
  mediaOrigin: string;
  turnstileSiteKey: string;
  workerKey: string;
  policyVersion: string;
}

/** Origin only: https anywhere, http for loopback (local backend / tests). Anything else falls back to prod. */
export function normalizeApiOrigin(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return PROD_API;
  try {
    const u = new URL(raw.trim());
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return u.origin;
  } catch {
    /* fall through */
  }
  return PROD_API;
}

export function bookingConfig(): BookingConfig {
  const e = env as unknown as Record<string, unknown>;
  const siteKey = typeof e.TURNSTILE_SITE_KEY === "string" ? e.TURNSTILE_SITE_KEY.trim() : "";
  return {
    apiOrigin: normalizeApiOrigin(e.API_ORIGIN),
    mediaOrigin: normalizeMediaOrigin(e.MEDIA_ORIGIN),
    turnstileSiteKey: /^[0-9A-Za-z_-]{1,64}$/.test(siteKey) ? siteKey : "",
    workerKey: typeof e.BOOKING_INFO_WORKER_KEY === "string" ? e.BOOKING_INFO_WORKER_KEY.trim() : "",
    policyVersion: PRIVACY_POLICY_VERSION,
  };
}
