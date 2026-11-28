// Phase 039: Access JWT check (requireOwner), adminFetch path allow-list / headers / error mapping, /admin response headers. Pure unit tests (no server).
import { test, describe } from "node:test";
import { rawRequest, BASE } from "./helpers/env.mjs";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { adminConfigFrom, adminConfigProblem, adminConfigResolve } from "../src/lib/admin/config.ts";
import { requireOwner, verifyOwner, requireActor, logAdminDenied, resetAdminDenialLog } from "../src/lib/admin/access.ts";
import { adminFetch, assertCatalogPath, errorMessage } from "../src/lib/admin/api.ts";
import { readFileSync } from "node:fs";
import { ALL as catchAll } from "../src/pages/admin/[...rest].ts";
import { register } from "node:module";
import { withSecurityHeaders, ADMIN_CSP, adminPath } from "../src/lib/securityHeaders.ts";

// The real middleware, with the Astro virtual module and `cloudflare:workers` (empty env = admin not configured) stubbed, as tests/middleware-log.test.mjs does.
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === "astro:middleware") return { url: "data:text/javascript,export const defineMiddleware = (f) => f;", shortCircuit: true };
  if (spec === "cloudflare:workers") return { url: "data:text/javascript,export const env = {};", shortCircuit: true };
  try { return await next(spec, ctx); } catch (e) { if (spec.startsWith(".") && !/\\.\\w+$/.test(spec)) return next(spec + ".ts", ctx); throw e; }
}`),
  import.meta.url,
);
const { onRequest } = await import("../src/middleware.ts");
const mw = (url, init) => onRequest({ request: new Request(url, init), locals: {} }, async () => new Response("PUBLIC PAGE", { status: 200 }));

const TEAM = "beautica.cloudflareaccess.com";
const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: "aud-prod", ADMIN_EMAILS: "Owner@Example.com, other@example.com", INTERNAL_CATALOG_KEY: "k".repeat(40), API_ORIGIN: "https://api.example.test" };
const cfg = adminConfigFrom(ENV);
const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });

const sign = (claims = {}, { key = privateKey, aud = "aud-prod", iss = `https://${TEAM}`, exp = "5m", alg = "RS256" } = {}) =>
  new SignJWT({ email: "owner@example.com", ...claims }).setProtectedHeader({ alg, kid: "k1" }).setAudience(aud).setIssuer(iss).setIssuedAt().setExpirationTime(exp).sign(key);
const req = (jwt) => new Request("https://beautica.app/admin", { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });
const status = async (r, c = cfg) => { const o = await requireOwner(r, c, jwks); return o instanceof Response ? o.status : o; };

describe("requireOwner", () => {
  test("valid token: the verified, lower-cased email", async () => assert.deepEqual(await status(req(await sign())), { email: "owner@example.com" }));
  test("email case is normalised on both sides", async () => assert.deepEqual(await status(req(await sign({ email: "OWNER@example.com" }))), { email: "owner@example.com" }));
  test("wrong aud (the other environment's Access app) -> 404", async () => assert.equal(await status(req(await sign({}, { aud: "aud-staging" }))), 404));
  test("wrong issuer -> 404", async () => assert.equal(await status(req(await sign({}, { iss: "https://evil.cloudflareaccess.com" }))), 404));
  test("expired -> 404", async () => assert.equal(await status(req(await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 }))), 404));
  test("email not in ADMIN_EMAILS -> 404", async () => assert.equal(await status(req(await sign({ email: "stranger@example.com" }))), 404));
  test("no email claim (service token) -> 404", async () => assert.equal(await status(req(await sign({ email: undefined }))), 404));
  test("signed by another key (forged) -> 404", async () => assert.equal(await status(req(await sign({}, { key: other.privateKey }))), 404));
  test("garbage token -> 404", async () => assert.equal(await status(req("a.b.c")), 404));
  test("alg none / HS256 -> 404", async () => {
    const hs = await new SignJWT({ email: "owner@example.com" }).setProtectedHeader({ alg: "HS256", kid: "k1" }).setAudience("aud-prod").setIssuer(`https://${TEAM}`).setExpirationTime("5m").sign(new TextEncoder().encode("s".repeat(32)));
    assert.equal(await status(req(hs)), 404);
  });
  test("missing header (a cookie alone does not count) -> 404", async () => {
    assert.equal(await status(req(null)), 404);
    assert.equal(await status(new Request("https://beautica.app/admin", { headers: { Cookie: `CF_Authorization=${await sign()}` } })), 404);
  });
  test("404 answer is no-store + noindex", async () => {
    const r = await requireOwner(req(null), cfg, jwks);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("x-robots-tag"), /noindex/);
  });
  for (const k of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "ADMIN_EMAILS", "INTERNAL_CATALOG_KEY", "API_ORIGIN"])
    test(`missing ${k} disables /admin (404)`, async () => {
      const c = adminConfigFrom({ ...ENV, [k]: "" });
      assert.equal(c, null);
      assert.equal(await verifyOwner(req(await sign()), c, jwks), null);
    });
  test("API_ORIGIN missing or invalid disables admin: never the prod fallback", () => {
    for (const v of [undefined, "", "   ", "not a url", "http://api.example.test", "ftp://x.test", "javascript:alert(1)"]) assert.equal(adminConfigFrom({ ...ENV, API_ORIGIN: v }), null, String(v));
    assert.equal(adminConfigFrom({ ...ENV, API_ORIGIN: "http://localhost:8080" }).apiOrigin, "http://localhost:8080");
    assert.equal(adminConfigFrom(ENV).apiOrigin, "https://api.example.test");
  });
  test("INTERNAL_CATALOG_KEY shorter than 32 characters disables admin", () => {
    assert.equal(adminConfigFrom({ ...ENV, INTERNAL_CATALOG_KEY: "k".repeat(31) }), null);
    assert.ok(adminConfigFrom({ ...ENV, INTERNAL_CATALOG_KEY: "k".repeat(32) }));
  });
  test("a team domain outside *.cloudflareaccess.com is refused", () => assert.equal(adminConfigFrom({ ...ENV, CF_ACCESS_TEAM_DOMAIN: "evil.example.com" }), null));
});

describe("adminFetch", () => {
  const origFetch = globalThis.fetch;
  const withFetch = async (impl, fn) => { globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = origFetch; } };
  test("path allow-list: anything outside /api/v1/internal/catalog/ throws", () => {
    for (const p of ["/api/v1/internal/moderation/reports", "/api/v1/internal/catalog", "/api/v1/internal/catalog/", "/api/v1/internal/catalog/../guest-pii", "/api/v1/internal/catalog/%2e%2e/x", "https://evil.test/api/v1/internal/catalog/x", "//evil.test/x", "/api/v1/internal/catalog//x", "/api/v1/internal/catalog/a#b"])
      assert.throws(() => assertCatalogPath(p), p);
    assert.doesNotThrow(() => assertCatalogPath("/api/v1/internal/catalog/category-requests?status=PENDING"));
  });
  test("sends the scoped key + actor to the configured origin, never the browser's headers", async () => {
    let seen;
    const r = await withFetch(async (url, init) => { seen = { url, init }; return Response.json({ success: true, data: { n: 1 } }); }, () => adminFetch(cfg, "GET", "/api/v1/internal/catalog/x", "owner@example.com"));
    assert.deepEqual(r, { ok: true, status: 200, data: { n: 1 } });
    assert.equal(seen.url, "https://api.example.test/api/v1/internal/catalog/x");
    assert.equal(seen.init.headers["X-Internal-Key"], ENV.INTERNAL_CATALOG_KEY);
    assert.equal(seen.init.headers["X-Admin-Actor"], "owner@example.com");
  });
  test("a bad actor throws before any request", async () => {
    await withFetch(async () => assert.fail("must not fetch"), async () => { await assert.rejects(adminFetch(cfg, "GET", "/api/v1/internal/catalog/x", "not an email")); });
  });
  test("typed 409 codes map to their own Ukrainian message, never the generic server error", async () => {
    for (const code of ["REQUEST_NOT_PENDING", "DUPLICATE_PENDING", "TYPE_EXISTS", "CATALOG_IN_USE"]) {
      const r = await withFetch(async () => Response.json({ success: false, data: { code }, message: "x" }, { status: 409 }), () => adminFetch(cfg, "POST", "/api/v1/internal/catalog/x", "owner@example.com", {}));
      assert.equal(r.ok, false);
      assert.equal(r.code, code);
      assert.notEqual(r.message, errorMessage(500, ""));
    }
    assert.notEqual(errorMessage(409, "UNKNOWN"), errorMessage(500, ""));
  });
  test("the code is read ONLY from data.code: top-level code/errorCode and an UPPER_SNAKE message are ignored", async () => {
    for (const body of [{ code: "TYPE_EXISTS" }, { errorCode: "TYPE_EXISTS" }, { message: "TYPE_EXISTS" }, { data: { message: "TYPE_EXISTS" } }, { data: null }]) {
      const r = await withFetch(async () => Response.json({ success: false, ...body }, { status: 409 }), () => adminFetch(cfg, "POST", "/api/v1/internal/catalog/x", "owner@example.com", {}));
      assert.equal(r.code, "", JSON.stringify(body));
    }
  });
  test("network failure -> unavailable result, not a throw", async () => {
    const r = await withFetch(async () => { throw new TypeError("x"); }, () => adminFetch(cfg, "GET", "/api/v1/internal/catalog/x", "owner@example.com"));
    assert.equal(r.status, 0);
  });
});

describe("admin path detection (decoded, case-insensitive)", () => {
  test("encoded and mixed-case spellings are admin paths", () => {
    for (const p of ["/admin", "/admin/x", "/%61dmin", "/%61dmin/x", "/%41DMIN", "/Admin/x", "/admin%2fx", "/admin%2Fx"]) assert.equal(adminPath(p).admin, true, p);
  });
  test("other paths are not", () => {
    for (const p of ["/", "/administrator", "/adminx", "/book/admin", "/%E0%A4%A"]) assert.equal(adminPath(p).admin, false, p);
  });
  test("a malformed escape on an admin path is flagged (fail closed), elsewhere it is ignored", () => {
    assert.deepEqual(adminPath("/admin/%E0%A4%A"), { admin: true, malformed: true });
    assert.deepEqual(adminPath("/%61dmin%zz"), { admin: true, malformed: true });
    assert.deepEqual(adminPath("/book/%E0%A4%A"), { admin: false, malformed: false });
  });
  test("withSecurityHeaders gives an encoded admin path the admin headers", () => {
    assert.equal(withSecurityHeaders(new Response("x"), "/%61dmin/x").headers.get("content-security-policy"), ADMIN_CSP);
  });
});

describe("middleware gate (real onRequest, no valid JWT)", () => {
  for (const p of ["/admin", "/admin/x", "/%61dmin", "/%61dmin/x", "/%41DMIN/x", "/admin%2fx", "/admin%2Fx/y", "/Admin", "/admin/%E0%A4%A", "/%61dmin%zz"])
    test(`${p}: 404 + admin headers, the route never runs`, async () => {
      const res = await mw(`https://beautica.app${p}`);
      assert.equal(res.status, 404);
      assert.notEqual(await res.text(), "PUBLIC PAGE");
      assert.equal(res.headers.get("content-security-policy"), ADMIN_CSP);
      assert.equal(res.headers.get("referrer-policy"), "same-origin");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("x-robots-tag"), /noindex/);
    });
  test("a cross-origin form POST to /admin/x: 403 with same-origin referrer + the admin CSP", async () => {
    const res = await mw("https://beautica.app/admin/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: "a=1" });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.equal(res.headers.get("content-security-policy"), ADMIN_CSP);
  });
  test("a non-admin path still reaches the route", async () => assert.equal(await (await mw("https://beautica.app/privacy")).text(), "PUBLIC PAGE"));
});

describe("every admin route re-checks locals.adminActor", () => {
  test("requireActor: 404 without a string actor, the actor with one", () => {
    for (const l of [undefined, null, {}, { adminActor: "" }, { adminActor: 1 }]) assert.equal(requireActor(l).status, 404);
    assert.equal(requireActor({ adminActor: "owner@example.com" }), "owner@example.com");
  });
  test("the catch-all route is 404 with and without the actor", () => {
    assert.equal(catchAll({ locals: {} }).status, 404);
    assert.equal(catchAll({ locals: { adminActor: "owner@example.com" } }).status, 404);
  });
  test("the index route uses requireActor and returns its Response before rendering (source pin)", () => {
    const src = readFileSync(new URL("../src/pages/admin/index.astro", import.meta.url), "utf8");
    assert.match(src, /const actor = requireActor\(Astro\.locals\);\s*\nif \(actor instanceof Response\) return actor;/);
  });
});

describe("/admin response headers", () => {
  for (const path of ["/admin", "/admin/requests"]) {
    test(`${path}: no-store, noindex, same-origin referrer, CSP without script-src`, () => {
      const res = withSecurityHeaders(new Response("x", { headers: { "Cache-Control": "public, max-age=60", "Content-Security-Policy": "default-src *" } }), path);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(res.headers.get("referrer-policy"), "same-origin");
      assert.equal(res.headers.get("content-security-policy"), ADMIN_CSP);
      assert.ok(!/script-src|umami|cloudflareinsights/.test(res.headers.get("content-security-policy")));
    });
  }
  test("/administrator is not an admin path", () => assert.notEqual(withSecurityHeaders(new Response("x"), "/administrator").headers.get("content-security-policy"), ADMIN_CSP));
});

// Through the real Worker (`npm test` / scripts/run-tests.mjs; skipped under a bare `node --test`). The test Worker has no Access vars and no JWT.
describe("/admin* routing (wrangler dev)", { skip: !BASE }, () => {
  for (const path of ["/admin", "/admin/requests", "/admin/anything", "/admin/a/b", "/admin/catalog?x=1"]) {
    test(`${path} without a valid JWT: 404 from the Worker with the admin headers`, async () => {
      for (const headers of [{}, { "Cf-Access-Jwt-Assertion": "forged.jwt.value" }]) {
        const res = await rawRequest(path, { headers });
        assert.equal(res.status, 404);
        assert.deepEqual(res.all("cache-control"), ["no-store"]);
        assert.deepEqual(res.all("x-robots-tag"), ["noindex, nofollow"]);
        assert.deepEqual(res.all("referrer-policy"), ["same-origin"]);
        assert.deepEqual(res.all("content-security-policy"), [ADMIN_CSP]);
      }
    });
  }
  test("encoded spellings never reach a page: the asset layer canonicalises them (307) and the target is gated", async () => {
    for (const p of ["/%61dmin", "/%61dmin/x", "/admin%2fx"]) {
      const res = await rawRequest(p);
      assert.ok(res.status === 404 || res.status === 307, `${p}: ${res.status}`);
      const target = res.status === 307 ? await rawRequest(res.headers.location) : res;
      assert.equal(target.status, 404);
      assert.deepEqual(target.all("content-security-policy"), [ADMIN_CSP]);
      assert.deepEqual(target.all("cache-control"), ["no-store"]);
    }
  });
  test("/admin/ is the asset-layer 307 to /admin, with the admin headers (HSTS, no-store, noindex, same-origin referrer, admin CSP)", async () => {
    const res = await rawRequest("/admin/");
    assert.equal(res.status, 307);
    assert.equal(res.headers.location, "/admin");
    assert.deepEqual(res.all("cache-control"), ["no-store"]);
    assert.deepEqual(res.all("x-robots-tag"), ["noindex, nofollow"]);
    assert.deepEqual(res.all("referrer-policy"), ["same-origin"]);
    assert.deepEqual(res.all("content-security-policy"), [ADMIN_CSP]);
    assert.match(res.headers["strict-transport-security"], /max-age=31536000/);
  });
  test("a cross-origin form POST to /admin/x is 403 with same-origin referrer + the admin CSP", async () => {
    const res = await rawRequest("/admin/x", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.deepEqual(res.all("referrer-policy"), ["same-origin"]);
    assert.deepEqual(res.all("content-security-policy"), [ADMIN_CSP]);
  });
  test("a POST to /admin/x is also gated (404)", async () => assert.equal((await rawRequest("/admin/x", { method: "POST" })).status, 404));
});

// Denial diagnostics: one console.warn JSON line per denied request, fixed reason codes only (never token, email, AUD, key, header values).
describe("admin denial log", () => {
  const capture = async (fn) => {
    const lines = [];
    resetAdminDenialLog();
    const orig = console.warn;
    console.warn = (...a) => lines.push(a.join(" "));
    try { await fn(); } finally { console.warn = orig; }
    return lines;
  };
  const denied = async (jwt, c = cfg) => capture(() => verifyOwner(req(jwt), c, jwks));
  const one = (lines) => { assert.equal(lines.length, 1); return JSON.parse(lines[0]); };
  const SECRETS = ["owner@example.com", "stranger@example.com", "aud-prod", "aud-staging", "k".repeat(40), "Bearer"];
  const noLeak = (lines, jwt) => { for (const s of [...SECRETS, ...(jwt ? [jwt, jwt.split(".")[1]] : [])]) assert.ok(!lines.join("\n").includes(s), `leaked ${s}`); };

  test("no_assertion_header", async () => {
    const l = await denied(null);
    assert.deepEqual(one(l), { event: "admin_denied", reason: "no_assertion_header" });
  });
  test("email_not_allowed", async () => {
    const jwt = await sign({ email: "stranger@example.com" });
    const l = await denied(jwt);
    assert.deepEqual(one(l), { event: "admin_denied", reason: "email_not_allowed" });
    noLeak(l, jwt);
  });
  test("jwt_invalid aud: claim name + aud shape only", async () => {
    const jwt = await sign({}, { aud: "aud-staging" });
    const l = await denied(jwt);
    assert.deepEqual(one(l), { event: "admin_denied", reason: "jwt_invalid:ERR_JWT_CLAIM_VALIDATION_FAILED:aud", aud_is_array: false, aud_count: 1 });
    noLeak(l, jwt);
  });
  test("jwt_invalid aud: array token reports array + count", async () => {
    const jwt = await sign({}, { aud: ["aud-staging", "aud-other"] });
    const l = await denied(jwt);
    const j = one(l);
    assert.equal(j.aud_is_array, true);
    assert.equal(j.aud_count, 2);
    noLeak(l, jwt);
  });
  test("jwt_invalid iss", async () => {
    const jwt = await sign({}, { iss: "https://evil.cloudflareaccess.com" });
    const l = await denied(jwt);
    assert.equal(one(l).reason, "jwt_invalid:ERR_JWT_CLAIM_VALIDATION_FAILED:iss");
    noLeak(l, jwt);
  });
  test("jwt_invalid exp", async () => {
    const l = await denied(await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 }));
    assert.equal(one(l).reason, "jwt_invalid:ERR_JWT_EXPIRED:exp");
  });
  test("jwt_invalid signature", async () => {
    const l = await denied(await sign({}, { key: other.privateKey }));
    assert.equal(one(l).reason, "jwt_invalid:ERR_JWS_SIGNATURE_VERIFICATION_FAILED");
  });
  test("jwt_invalid no matching key", async () => {
    const noKey = createLocalJWKSet({ keys: [] });
    const l = await capture(() => verifyOwner(req("x"), cfg, noKey));
    assert.match(one(l).reason, /^jwt_invalid:ERR_[A-Z_]+$/);
  });
  test("jwt_invalid fetch failure / non-jose error -> sanitized code", async () => {
    const boom = async () => { throw new Error("secret-host-detail aud-prod"); };
    const jwt = await sign();
    const l = await capture(() => verifyOwner(req(jwt), cfg, boom));
    assert.equal(one(l).reason, "jwt_invalid:UNKNOWN");
    noLeak(l, jwt);
  });
  test("denial keeps the exact 404 body and headers", async () => {
    const [r] = await Promise.all([requireOwner(req(null), cfg, jwks)]);
    assert.equal(r.status, 404);
    assert.equal(await r.text(), "Not Found");
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  });
  test("config_missing:<FIELD> names each failing check, in order, never values", () => {
    const cases = [
      [{ CF_ACCESS_TEAM_DOMAIN: "evil.example.com" }, "CF_ACCESS_TEAM_DOMAIN"],
      [{ CF_ACCESS_AUD: "" }, "CF_ACCESS_AUD"],
      [{ ADMIN_EMAILS: " , " }, "ADMIN_EMAILS"],
      [{ INTERNAL_CATALOG_KEY: "short" }, "INTERNAL_CATALOG_KEY"],
      [{ API_ORIGIN: "http://api.example.test" }, "API_ORIGIN"],
    ];
    for (const [patch, field] of cases) {
      const e = { ...ENV, ...patch };
      assert.equal(adminConfigProblem(e), field);
      assert.equal(adminConfigFrom(e), null);
    }
    assert.equal(adminConfigProblem(ENV), null);
    assert.ok(adminConfigFrom(ENV));
  });
  test("adminConfigResolve parses once and agrees with the two public views", () => {
    assert.deepEqual(adminConfigResolve({ ...ENV, API_ORIGIN: "" }), { config: null, problem: "API_ORIGIN" });
    assert.deepEqual(adminConfigResolve(ENV), { config: cfg, problem: null });
    // The middleware must resolve config once per request: no second parse via a separate issue lookup.
    const src = readFileSync(new URL("../src/middleware.ts", import.meta.url), "utf8");
    assert.equal((src.match(/adminConfigState\(\)/g) ?? []).length, 1);
    assert.ok(!/adminConfigIssue|adminConfig\(\)/.test(src));
  });
  test("throttle: same reason twice in the window logs once; after the window it logs again with suppressed", async () => {
    let t = 1_000_000;
    const l = await capture(async () => {
      resetAdminDenialLog(() => t);
      logAdminDenied("config_missing:API_ORIGIN");
      logAdminDenied("config_missing:API_ORIGIN");
      logAdminDenied("no_assertion_header"); // a different reason is its own first occurrence
      t += 59_999;
      logAdminDenied("config_missing:API_ORIGIN");
      t += 1;
      logAdminDenied("config_missing:API_ORIGIN");
    });
    resetAdminDenialLog();
    assert.deepEqual(l.map((x) => JSON.parse(x)), [
      { event: "admin_denied", reason: "config_missing:API_ORIGIN" },
      { event: "admin_denied", reason: "no_assertion_header" },
      { event: "admin_denied", reason: "config_missing:API_ORIGIN", suppressed: 2 },
    ]);
  });
  test("throttle state is bounded: the 65th distinct reason evicts the oldest, which then logs again at once; a recent one stays throttled", async () => {
    const l = await capture(async () => {
      resetAdminDenialLog(() => 5); // frozen clock: nothing ages out, only the 64-entry cap can make a reason log again
      for (let i = 0; i < 65; i++) logAdminDenied(`r${i}`); // r0..r63 fill the cap, r64 evicts r0
      logAdminDenied("r63"); // still tracked -> suppressed
      logAdminDenied("r0"); // evicted -> a first occurrence again (no `suppressed`)
    });
    resetAdminDenialLog();
    const reasons = l.map((x) => JSON.parse(x));
    assert.equal(reasons.length, 66);
    assert.deepEqual(reasons[65], { event: "admin_denied", reason: "r0" });
    assert.equal(reasons.filter((r) => r.reason === "r63").length, 1);
  });
  test("middleware logs config_missing once and still answers the same 404", async () => {
    let res;
    const l = await capture(async () => { res = await mw("https://beautica.app/admin"); });
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not Found");
    assert.deepEqual(l.map((x) => JSON.parse(x)), [
      { event: "admin_denied", reason: "config_missing:CF_ACCESS_TEAM_DOMAIN" },
    ]);
  });
});
