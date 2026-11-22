#!/usr/bin/env node
// TEST-ONLY harness (phase 039): renders the authenticated /admin page from the BUILT Worker for html-validate, axe and screenshots.
// src/ has no bypass, flag or alternative key path: the real middleware + Access-JWT check run. The harness copies dist/ to a temp dir,
// swaps ONLY the JWKS URL in that copy (https://<team>/cdn-cgi/access/certs -> a local server that serves a throwaway public key), runs
// `wrangler dev` on the copy with test vars, and sends a JWT signed with the throwaway private key.
//
//   npm run build
//   node scripts/render-admin.mjs --out /tmp/admin.html [--path /admin]   # writes the HTML, exit 0 on 200
//   node scripts/render-admin.mjs --serve 4399                            # http://127.0.0.1:4399/admin ; a proxy adds the JWT header (axe, screenshots)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] ?? ""; };
if (!existsSync("dist/server/wrangler.json")) { console.error("render-admin: dist/ is missing, run `npm run build` first"); process.exit(2); }
const freePort = () => new Promise((res, rej) => { const s = netServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });

const TEAM = "beautica.cloudflareaccess.com", AUD = "test-aud", EMAIL = process.env.RENDER_ADMIN_EMAIL ?? "owner@example.com"; // env override: the shell test uses an HTML-special address
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "t1", alg: "RS256", use: "sig" };
const jwt = await new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: "RS256", kid: "t1" }).setAudience(AUD).setIssuer(`https://${TEAM}`).setIssuedAt().setExpirationTime("1h").sign(privateKey);

const jwksServer = createServer((_, rs) => { rs.setHeader("Content-Type", "application/json"); rs.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => jwksServer.listen(0, "127.0.0.1", r));
const jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/certs`;

const work = mkdtempSync(join(tmpdir(), "beautica-admin-"));
cpSync("dist", join(work, "dist"), { recursive: true });
const chunks = join(work, "dist/server/chunks");
const needle = "`https://${team}/cdn-cgi/access/certs`";
const file = readdirSync(chunks).find((f) => readFileSync(join(chunks, f), "utf8").includes(needle));
if (!file) { console.error("render-admin: JWKS URL not found in the build (access.ts changed?)"); process.exit(2); }
writeFileSync(join(chunks, file), readFileSync(join(chunks, file), "utf8").replace(needle, JSON.stringify(jwksUrl)));

if (process.env.RENDER_ADMIN_DEBUG) { // debug only: the middleware logs the error NAME only (token URLs); show the stack of the temp copy
  const m = join(work, "dist/server/virtual_astro_middleware.mjs");
  writeFileSync(m, readFileSync(m, "utf8").replace('err?.name)', 'err?.stack)'));
}
const port = await freePort();
const wr = spawn("npx", ["--no-install", "wrangler", "dev", "-c", join(work, "dist/server/wrangler.json"), "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false", "--persist-to", join(work, "state"),
  "--var", `CF_ACCESS_TEAM_DOMAIN:${TEAM}`, "--var", `CF_ACCESS_AUD:${AUD}`, "--var", `ADMIN_EMAILS:${EMAIL}`, "--var", "INTERNAL_CATALOG_KEY:test-catalog-key-0000000000000000000", "--var", "API_ORIGIN:http://127.0.0.1:9"],
  { stdio: process.env.RENDER_ADMIN_DEBUG ? "inherit" : "ignore", detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } });
const stop = () => { try { process.kill(-wr.pid, "SIGKILL"); } catch { /* gone */ } jwksServer.close(); rmSync(work, { recursive: true, force: true }); };
process.on("exit", stop);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));

const base = `http://127.0.0.1:${port}`;
const send = (path, withJwt = true) => fetch(base + path, { headers: withJwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}, redirect: "manual" });
for (let i = 0; ; i++) {
  try { if ((await fetch(base + "/", { signal: AbortSignal.timeout(2000) })).status === 200) break; } catch { /* not up */ }
  if (i > 360) { console.error("render-admin: wrangler dev did not start in 90 s"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}

if (arg("--serve") !== undefined) {
  const p = Number(arg("--serve")) || 4399;
  createServer(async (rq, rs) => {
    const r = await send(rq.url);
    const h = Object.fromEntries(r.headers); delete h["content-encoding"]; delete h["content-length"];
    rs.writeHead(r.status, h);
    rs.end(Buffer.from(await r.arrayBuffer()));
  }).listen(p, "127.0.0.1", () => console.log(`render-admin: http://127.0.0.1:${p}/admin (Ctrl-C to stop)`));
} else {
  const res = await send(arg("--path") ?? "/admin");
  const html = await res.text();
  if (arg("--out")) writeFileSync(arg("--out"), html); else process.stdout.write(html);
  console.error(`render-admin: ${res.status} CSP: ${res.headers.get("content-security-policy")}`);
  if (res.status !== 200) await new Promise((r) => setTimeout(r, 1500)); // let wrangler flush its log (RENDER_ADMIN_DEBUG=1)
  process.exit(res.status === 200 ? 0 : 1);
}
