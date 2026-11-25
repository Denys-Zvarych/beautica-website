// Cloudflare Access JWT check (phase 039, D1/D3). Defence in depth: Access gates the edge, the Worker verifies the assertion again, so a
// misconfigured policy or a direct *.workers.dev hit still gets 404. Independent of the IdP (Google, one-time PIN...): only the signed
// claims count. Header only (`Cf-Access-Jwt-Assertion`), never the CF_Authorization cookie.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
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

/** The verified owner email, or null for anything else (no header, bad signature, aud/iss/exp, email not allowed). `jwks` is for tests. */
export async function verifyOwner(request: Request, cfg: AdminConfig | null, jwks?: JWTVerifyGetKey): Promise<string | null> {
  if (!cfg) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks ?? remoteJwks(cfg.teamDomain), {
      algorithms: ["RS256"],
      issuer: `https://${cfg.teamDomain}`,
      audience: cfg.aud,
      clockTolerance: 5,
      requiredClaims: ["exp"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    return email && cfg.emails.includes(email) ? email : null;
  } catch {
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
