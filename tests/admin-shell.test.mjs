// Phase 039 (WEB-68) QA: the built /admin shell end to end (scripts/render-admin.mjs: real middleware + Access-JWT check, throwaway key),
// the jose containment of the build, and the Access wrangler config. Needs a built dist/. No network beyond localhost.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, uk } from "./helpers/env.mjs";

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("/admin shell, signed in (built Worker via render-admin)", () => {
  const EMAIL = `a<i>b"&c@example.com`; // HTML-special on purpose: the actor line must come out escaped
  const tmp = mkdtempSync(join(tmpdir(), "admin-shell-"));
  const out = join(tmp, "admin.html");
  const run = spawnSync(process.execPath, ["scripts/render-admin.mjs", "--out", out], {
    cwd: ROOT, env: { ...process.env, RENDER_ADMIN_EMAIL: EMAIL }, encoding: "utf8", timeout: 120_000,
  });
  const html = run.status === 0 ? readFileSync(out, "utf8") : "";
  const main = html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
  test.after(() => rmSync(tmp, { recursive: true, force: true }));

  test("renders 200 for the signed-in owner", () => assert.equal(run.status, 0, run.stderr));
  test("the h1 is the catalog heading", () => assert.match(html, new RegExp(`<h1[^>]*>${uk.admin.h1}</h1>`)));
  test("the actor email is shown HTML-escaped, never as markup", () => {
    assert.ok(main.includes(escapeHtml(EMAIL)), "escaped email missing from <main>");
    assert.ok(!main.includes("<i>b"), "raw markup from the email reached the page");
  });
  test("both «скоро» chips are plain labels, not links", () => {
    const items = [...main.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    assert.equal(items.length, 2);
    for (const [i, label] of [uk.admin.requests, uk.admin.catalog].entries()) {
      assert.equal(items[i].replace(/<[^>]*>/g, ""), `${label} · ${uk.admin.soon}`);
    }
    assert.ok(!/<a[\s>]/.test(main), "a link inside the shell");
  });
  test("the page has no <script> and no inline handler", () => {
    assert.ok(!/<script/i.test(html), "script tag");
    assert.ok(!/\son[a-z]+\s*=/i.test(html), "inline event handler");
  });
  test("noindex meta, no analytics host", () => {
    assert.match(html, /<meta name="robots" content="noindex/);
    assert.ok(!/umami|cloudflareinsights/i.test(html));
  });
});

describe("jose stays out of the public build", () => {
  const server = walk(join(ROOT, "dist/server")).filter((f) => f.endsWith(".mjs"));
  const access = server.filter((f) => /jwtVerify|createRemoteJWKSet/.test(readFileSync(f, "utf8")));
  const base = (f) => f.split("/").pop();

  test("the Access-JWT code is in exactly one server chunk", () => assert.equal(access.length, 1, access.join(", ")));
  test("dist/client carries no jose, Access or catalog-key code", () => {
    const hits = walk(join(ROOT, "dist/client")).filter((f) => /jwtVerify|createRemoteJWKSet|cf-access-jwt|INTERNAL_CATALOG_KEY|X-Admin-Actor/i.test(readFileSync(f, "latin1")));
    assert.deepEqual(hits, []);
  });
  test("only the admin routes import that chunk statically; the middleware loads it lazily (so no public route pulls jose in)", () => {
    const name = base(access[0]).replace(/\.mjs$/, "");
    const staticImport = new RegExp(`^\\s*(?:import|export)\\b[^\\n;]*?["'][^"'\\n]*${name}`, "m");
    const importers = server.filter((f) => f !== access[0] && staticImport.test(readFileSync(f, "utf8")));
    assert.equal(importers.length, 2, "the /admin page and the catch-all route: " + importers.map(base)); // a third importer = a public route now loads jose
    for (const f of importers) assert.match(readFileSync(f, "utf8"), /requireActor\(/, `${base(f)} imports jose code but is not an admin route`);
    const lazy = server.filter((f) => new RegExp(`\\bimport\\(\\s*["'][^"']*${name}`).test(readFileSync(f, "utf8"))).map(base);
    assert.deepEqual(lazy, ["virtual_astro_middleware.mjs"]);
  });
});

describe("wrangler.jsonc Access config (prod and staging)", () => {
  const jsonc = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  // Strip // comments outside strings (the URLs contain "//").
  const cfg = JSON.parse(jsonc.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (m, s) => s ?? ""));
  const TEAM = "beautica.cloudflareaccess.com";

  test("vars and previews.vars set the same Access team domain", () => {
    assert.equal(cfg.vars.CF_ACCESS_TEAM_DOMAIN, TEAM);
    assert.equal(cfg.previews.vars.CF_ACCESS_TEAM_DOMAIN, TEAM);
  });
  test("neither var block holds the AUD, an admin email or the catalog key", () => {
    for (const [where, vars] of [["vars", cfg.vars], ["previews.vars", cfg.previews.vars]]) {
      for (const k of ["CF_ACCESS_AUD", "ADMIN_EMAILS", "INTERNAL_CATALOG_KEY"]) assert.ok(!(k in vars), `${where}.${k} is committed`);
    }
    assert.ok(!/ADMIN_EMAILS|INTERNAL_CATALOG_KEY\s*"?\s*:|CF_ACCESS_AUD\s*"?\s*:/.test(jsonc.replace(/\/\/[^\n]*/g, "")), "a secret-class key appears outside comments");
  });
  test("/admin is worker-first (asset layer never serves it), /admin/ stays the 307 asset rule", () => {
    const rwf = cfg.assets.run_worker_first;
    for (const p of ["/admin", "/admin/*", "!/admin/"]) assert.ok(rwf.includes(p), p);
  });
});
