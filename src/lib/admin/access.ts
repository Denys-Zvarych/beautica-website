// Cloudflare Access JWT check (phase 039, D1/D3). Defence in depth: Access gates the edge, the Worker verifies the assertion again, so a
// misconfigured policy or a direct *.workers.dev hit still gets 404. Independent of the IdP (Google, one-time PIN...): only the signed
// claims count. Header only (`Cf-Access-Jwt-Assertion`), never the CF_Authorization cookie.
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AdminConfig } from "./config.ts";

const JWKS_TTL_MS = 60 * 60 * 1000;
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function remoteJwks(team: string): JWTVerifyGetKey {
  let jwks = jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`), { cacheMaxAge: JWKS_TTL_MS, timeoutDuration: 5000 });
    jwksByTeam.set(team, jwks);
  }
  return jwks;
}

export const notFound = (): Response =>
  new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });

const LOG_WINDOW_MS = 60_000;
const LOG_MAX_REASONS = 64;
const lastLogged = new Map<string, { ts: number; suppressed: number }>();
let clock: () => number = Date.now;

/** Tests only: inject the clock (undefined restores Date.now) and clear the throttle state. */
export function resetAdminDenialLog(now?: () => number): void {
  clock = now ?? Date.now;
  lastLogged.clear();
}

/**
 * One structured line per denied /admin request, throttled per isolate: at most one line per reason code per 60 s (the first occurrence
 * of every reason always logs), so an /admin probe flood cannot exhaust the Workers log quota. The next emitted line carries `suppressed`.
 * Fixed reason codes and counts only: never the token, email, AUD, key or any header value.
 */
export function logAdminDenied(reason: string, extra: Record<string, number | boolean> = {}): void {
  const now = clock();
  const prev = lastLogged.get(reason);
  if (prev && now - prev.ts >= 0 && now - prev.ts < LOG_WINDOW_MS) {
    prev.suppressed++;
    return;
  }
  if (!prev && lastLogged.size >= LOG_MAX_REASONS) lastLogged.delete(lastLogged.keys().next().value as string); // bounded: drop the oldest
  lastLogged.delete(reason); // re-insert so Map order tracks recency
  lastLogged.set(reason, { ts: now, suppressed: 0 });
  console.warn(JSON.stringify({ event: "admin_denied", reason, ...extra, ...(prev && prev.suppressed > 0 ? { suppressed: prev.suppressed } : {}) }));
}

const CLAIMS = new Set(["aud", "iss", "exp", "nbf", "iat", "sub"]);

/** `jwt_invalid:<jose code>[:<claim>]` from a jose error; only whitelisted shapes reach the log. */
function jwtReason(err: unknown): string {
  const e = err as { code?: unknown; claim?: unknown } | null;
  const code = typeof e?.code === "string" && /^ERR_[A-Z0-9_]{1,60}$/.test(e.code) ? e.code : "UNKNOWN";
  const claim = typeof e?.claim === "string" && CLAIMS.has(e.claim) ? e.claim : "";
  return `jwt_invalid:${code}${claim ? `:${claim}` : ""}`;
}

/**
 * Shape of the aud claim of the UNVERIFIED token (decoded without checking the signature, and only reached because verification failed).
 * `aud_is_array` / `aud_count` are attacker-controllable hints for diagnosis, not facts. Never the values.
 */
function audShape(token: string): Record<string, number | boolean> {
  try {
    const aud = decodeJwt(token).aud;
    return { aud_is_array: Array.isArray(aud), aud_count: Array.isArray(aud) ? aud.length : aud === undefined ? 0 : 1 };
  } catch {
    return {};
  }
}

/** The verified owner email, or null for anything else (no header, bad signature, aud/iss/exp, email not allowed). `jwks` is for tests. */
export async function verifyOwner(request: Request, cfg: AdminConfig | null, jwks?: JWTVerifyGetKey): Promise<string | null> {
  if (!cfg) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    logAdminDenied("no_assertion_header");
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks ?? remoteJwks(cfg.teamDomain), {
      algorithms: ["RS256"],
      issuer: `https://${cfg.teamDomain}`,
      audience: cfg.aud,
      clockTolerance: 5,
      requiredClaims: ["exp"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (email && cfg.emails.includes(email)) return email;
    logAdminDenied("email_not_allowed");
    return null;
  } catch (err) {
    const reason = jwtReason(err);
    logAdminDenied(reason, reason.endsWith(":aud") ? audShape(token) : {});
    return null;
  }
}

/** `{ email }` for the owner, else the 404 Response to return as is. */
export async function requireOwner(request: Request, cfg: AdminConfig | null, jwks?: JWTVerifyGetKey): Promise<{ email: string } | Response> {
  const email = await verifyOwner(request, cfg, jwks);
  return email ? { email } : notFound();
}

/**
 * Shared pattern for EVERY /admin route (W039 index, the catch-all, W040/W041 pages and POSTs): the middleware gate puts the verified email in
 * `locals.adminActor`; each route re-checks it here and answers 404 without it, so a route can never render outside the gate.
 */
export function requireActor(locals: unknown): string | Response {
  const actor = (locals as { adminActor?: unknown } | null | undefined)?.adminActor;
  return typeof actor === "string" && actor !== "" ? actor : notFound();
}
