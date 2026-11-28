#!/usr/bin/env node
// TEST-ONLY harness (phase 039): renders the authenticated /admin page from the BUILT Worker for html-validate, axe and screenshots.
// src/ has no bypass, flag or alternative key path: the real middleware + Access-JWT check run. The harness copies dist/ to a temp dir,
// swaps ONLY the JWKS URL in that copy (https://<team>/cdn-cgi/access/certs -> a local server that serves a throwaway public key), runs
// `wrangler dev` on the copy with test vars, and sends a JWT signed with the throwaway private key.
//
//   npm run build
//   node scripts/render-admin.mjs --out /tmp/admin.html [--path /admin]   # writes the HTML, exit 0 on 200
//   node scripts/render-admin.mjs --serve 4399                            # http://127.0.0.1:4399/admin ; a proxy adds the JWT header (axe, screenshots)
//   --method POST --body 'kind=CATEGORY&id=1&action=approve&...' --calls /tmp/calls.json   # one form POST (same-origin), prints the redirect Location;
//                                                                                          # --cookie 'k=v' sends a Cookie; Set-Cookie is printed; --calls dumps the requests the mock catalog backend received
//   --serve also answers GET /__mock/calls (the mock backend's call log) and lets a POST override its Origin with `x-test-origin` (a cross-site post); Cookie is forwarded.
// RENDER_ADMIN_ANON=1 makes the --serve proxy send NO Access JWT (a denied request, for the denial-log test); RENDER_ADMIN_LOG=<file> appends the
// Worker's stdout/stderr (its console.warn lines) to that file instead of dropping it.
// CATALOG_MOCK_ROWS=100 pads the mock list to 100 requests; CATALOG_MOCK_CATEGORIES=200 pads the live catalog to 200 categories x 12 types (perf runs).
// The backend is a local mock of the catalog endpoints (scripts/lib/catalog-mock.mjs, test-only, sample data); nothing in src/ knows about it.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { startCatalogMock } from "./lib/catalog-mock.mjs";
import { ATTEMPTS, ATTEMPT_MS } from "./lib/admin-harness.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] ?? ""; };
for (let i = 0; i < 40 && !existsSync("dist/server/wrangler.json"); i++) await new Promise((r) => setTimeout(r, 500)); // a rebuild in flight
if (!existsSync("dist/server/wrangler.json")) { console.error("render-admin: dist/ is missing, run `npm run build` first"); process.exit(2); }
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });

const TEAM = "beautica.cloudflareaccess.com", AUD = "test-aud", EMAIL = process.env.RENDER_ADMIN_EMAIL ?? "owner@example.com"; // env override: the shell test uses an HTML-special address
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "t1", alg: "RS256", use: "sig" };
const jwt = await new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: "RS256", kid: "t1" }).setAudience(AUD).setIssuer(`https://${TEAM}`).setIssuedAt().setExpirationTime("1h").sign(privateKey);

const jwksServer = createServer((_, rs) => { rs.setHeader("Content-Type", "application/json"); rs.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => jwksServer.listen(0, "127.0.0.1", r));
const jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/certs`;

const mock = await startCatalogMock();
const work = mkdtempSync(join(tmpdir(), "beautica-admin-"));
// A concurrent `npm run build` replaces dist/ for a few seconds (the cause of the "exit 2" flake seen in tests/admin-requests): retry the copy + patch.
const needle = "`https://${team}/cdn-cgi/access/certs`";
let patched = false;
for (let i = 0; i < 40 && !patched; i++) {
  try {
    rmSync(join(work, "dist"), { recursive: true, force: true });
    cpSync("dist", join(work, "dist"), { recursive: true });
    const chunks = join(work, "dist/server/chunks");
    const file = readdirSync(chunks).find((f) => readFileSync(join(chunks, f), "utf8").includes(needle));
    if (!file) throw new Error("no jwks chunk");
    writeFileSync(join(chunks, file), readFileSync(join(chunks, file), "utf8").replace(needle, JSON.stringify(jwksUrl)));
    patched = existsSync(join(work, "dist/server/wrangler.json"));
  } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!patched) { console.error("render-admin: JWKS URL not found in the build (access.ts changed?) or dist/ kept changing"); process.exit(2); }

if (process.env.RENDER_ADMIN_DEBUG) { // debug only: the middleware logs the error NAME only (token URLs); show the stack of the temp copy
  const m = join(work, "dist/server/virtual_astro_middleware.mjs");
  writeFileSync(m, readFileSync(m, "utf8").replace('err?.name)', 'err?.stack)'));
}
// Cleanup is armed BEFORE anything slow starts: a SIGINT / SIGTERM at any point (even while wrangler boots) removes the temp dir and the children.
let wr;
const stop = () => { try { if (wr) process.kill(-wr.pid, "SIGKILL"); } catch { /* gone */ } jwksServer.close(); mock.close(); rmSync(work, { recursive: true, force: true }); };
process.on("exit", stop);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
// A start is bounded per attempt (a healthy one takes 10-15 s), not once for 240 s: a wrangler that never comes up (exited, or alive but stuck while
// its siblings were booting: CI PR #68 sat the whole 240 s on one) is killed and replaced on fresh ports. The inspector port is explicit too:
// wrangler's own default is one fixed port that concurrent test files would fight over. The log goes to a file in the temp dir, shown on failure.
const logFile = process.env.RENDER_ADMIN_LOG ?? join(work, "wrangler.log");
let port, base;
const startWrangler = async () => {
  port = await freePort();
  const inspector = await freePort();
  base = `http://127.0.0.1:${port}`;
  const fd = openSync(logFile, "a");
  const child = spawn("npx", ["--no-install", "wrangler", "dev", "-c", join(work, "dist/server/wrangler.json"), "--port", String(port), "--inspector-port", String(inspector), "--ip", "127.0.0.1", "--show-interactive-dev-session=false", "--persist-to", join(work, "state"),
    "--var", `CF_ACCESS_TEAM_DOMAIN:${TEAM}`, "--var", `CF_ACCESS_AUD:${AUD}`, "--var", `ADMIN_EMAILS:${EMAIL}`, "--var", "INTERNAL_CATALOG_KEY:test-catalog-key-0000000000000000000", "--var", `API_ORIGIN:${mock.origin}`],
    { stdio: process.env.RENDER_ADMIN_DEBUG ? "inherit" : ["ignore", fd, fd], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
  child.exited = false;
  child.on("exit", () => { child.exited = true; });
  return child;
};
const killWrangler = (c) => { try { if (c) process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } };
for (let attempt = 1; ; attempt++) {
  killWrangler(wr);
  wr = await startWrangler();
  const deadline = Date.now() + ATTEMPT_MS;
  let up = false;
  while (!up && !wr.exited && Date.now() < deadline) {
    try { up = (await fetch(base + "/", { signal: AbortSignal.timeout(2000) })).status === 200; } catch { /* not up */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (up) break;
  console.error(`render-admin: wrangler dev attempt ${attempt}/${ATTEMPTS} ${wr.exited ? "exited" : `not ready in ${ATTEMPT_MS / 1000} s`} on port ${port}`);
  if (attempt >= ATTEMPTS) {
    console.error("render-admin: wrangler dev did not start; log tail:\n" + (existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-1500) : "(no log)"));
    process.exit(1);
  }
}
const send = (path, withJwt = true, init = {}) => fetch(base + path, { ...init, headers: { ...(withJwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}), ...init.headers }, redirect: "manual" });

if (arg("--serve") !== undefined) {
  const p = arg("--serve") === "0" ? 0 : Number(arg("--serve")) || 4399; // 0 = a free port (reported below)
  const origins = [];
  const proxy = createServer(async (rq, rs) => {
    // Test hooks (tests/admin-requests-live.test.mjs): the mock catalog backend's call log, as JSON.
    if (rq.url === "/__mock/origins") { rs.writeHead(200, { "Content-Type": "application/json" }); return rs.end(JSON.stringify(origins)); }
    if (rq.url === "/__mock/calls") { rs.writeHead(200, { "Content-Type": "application/json" }); return rs.end(JSON.stringify(mock.calls)); }
    const chunks = []; for await (const c of rq) chunks.push(c);
    const post = rq.method !== "GET" && rq.method !== "HEAD";
    // A browser form post carries Origin = the proxy; the Worker compares it to its own origin, so present it as same-origin (the proxy's own origin only).
    // Any other Origin the client sent (a real browser under `Referrer-Policy: no-referrer` sends the string "null") is forwarded UNCHANGED and logged at /__mock/origins.
    const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`, sentOrigin = rq.headers.origin;
    if (post) origins.push(sentOrigin ?? null);
    const workerOrigin = rq.headers["x-test-origin"] ?? (sentOrigin && sentOrigin !== proxyOrigin ? sentOrigin : base);
    const r = await send(rq.url, !process.env.RENDER_ADMIN_ANON, post ? { method: rq.method, body: Buffer.concat(chunks), headers: { "Content-Type": rq.headers["content-type"] ?? "application/x-www-form-urlencoded", Origin: workerOrigin, ...(rq.headers.cookie ? { Cookie: rq.headers.cookie } : {}) } } : rq.headers.cookie ? { headers: { Cookie: rq.headers.cookie } } : {});
    const h = Object.fromEntries(r.headers); delete h["content-encoding"]; delete h["content-length"];
    let body = Buffer.from(await r.arrayBuffer());
    // Mirror the Cloudflare edge: compressed text responses (Lighthouse and the budgets measure what the browser downloads).
    if (/gzip/.test(rq.headers["accept-encoding"] ?? "") && /text|json|xml|javascript|svg/.test(h["content-type"] ?? "") && body.length > 0) { body = gzipSync(body); h["content-encoding"] = "gzip"; h.vary = "Accept-Encoding"; }
    rs.writeHead(r.status, h);
    rs.end(body);
  });
  proxy.listen(p, "127.0.0.1", () => console.log(`render-admin: http://127.0.0.1:${proxy.address().port}/admin (Ctrl-C to stop)`));
} else {
  const post = (arg("--method") ?? "GET").toUpperCase() === "POST";
  const res = await send(arg("--path") ?? "/admin", true, post ? { method: "POST", body: arg("--body") ?? "", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base, ...(arg("--cookie") ? { Cookie: arg("--cookie") } : {}) } } : arg("--cookie") ? { headers: { Cookie: arg("--cookie") } } : {});
  const html = await res.text();
  if (arg("--calls")) writeFileSync(arg("--calls"), JSON.stringify(mock.calls));
  if (arg("--out")) writeFileSync(arg("--out"), html); else process.stdout.write(html);
  console.error(`render-admin: ${res.status} CSP: ${res.headers.get("content-security-policy")} Location: ${res.headers.get("location") ?? ""}\nSet-Cookie: ${res.headers.get("set-cookie") ?? ""}`);
  const ok = res.status === 200 || (post && res.status === 303);
  if (!ok) await new Promise((r) => setTimeout(r, 1500)); // let wrangler flush its log (RENDER_ADMIN_DEBUG=1)
  process.exit(ok ? 0 : 1);
}
