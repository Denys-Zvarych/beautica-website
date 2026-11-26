// Phase 039 / W052 (WEB-68, WEB-69) QA: the built /admin shell end to end (scripts/render-admin.mjs: real middleware + Access-JWT check, throwaway key),
// the jose containment of the build, and the Access wrangler config. Needs a built dist/. No network beyond localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_CSP } from "../src/lib/securityHeaders.ts";
import { startAdminHarness } from "./helpers/admin-harness.mjs";
import { ROOT, uk } from "./helpers/env.mjs";

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("/admin shell, signed in (built Worker via render-admin)", () => {
  const EMAIL = `a<i>b"&c@example.com`; // HTML-special on purpose: the actor line must come out escaped
  const tmp = mkdtempSync(join(tmpdir(), "admin-shell-"));
  const out = join(tmp, "admin.html");
  const run = spawnSync(process.execPath, ["scripts/render-admin.mjs", "--out", out], {
    cwd: ROOT, env: { ...process.env, RENDER_ADMIN_EMAIL: EMAIL }, encoding: "utf8", timeout: 300_000,
  });
  const html = run.status === 0 ? readFileSync(out, "utf8") : "";
  const main = html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
  test.after(() => rmSync(tmp, { recursive: true, force: true }));

  test("renders 200 for the signed-in owner", () => assert.equal(run.status, 0, run.stderr));
  test("the h1 is the overview heading", () => assert.match(html, new RegExp(`<h1[^>]*>${uk.admin.h1}</h1>`)));
  test("the actor email is shown HTML-escaped in the top bar, never as markup", () => {
    assert.ok(html.includes(`<span class="who-mail">${escapeHtml(EMAIL)}</span>`), "escaped email missing from the top bar");
    assert.ok(!html.includes("<i>b"), "raw markup from the email reached the page");
    assert.ok(html.includes("Ви увійшли як"));
  });
  test("the sidebar is the data-driven nav: «Огляд» + the «Категорії» section with «Заявки» and «Каталог»; «Огляд» is current; «Вийти» goes to Cloudflare Access", () => {
    const nav = html.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const links = [...nav.matchAll(/<a class="nav-i" href="([^"]+)"([^>]*)>/g)].map((m) => [m[1], /aria-current="page"/.test(m[2])]);
    assert.deepEqual(links, [["/admin", true], ["/admin/requests", false], ["/admin/catalog", false]]);
    assert.ok(nav.includes(`>${uk.admin.nav.categories}</p>`) && nav.includes(`>${uk.admin.nav.requests}<`) && nav.includes(`>${uk.admin.nav.catalog}<`));
    assert.match(html, /href="\/cdn-cgi\/access\/logout"/);
    assert.ok(html.includes(uk.admin.footA) && html.includes(uk.admin.footB));
    assert.match(html, /<nav class="crumbs[^"]*" aria-label="[^"]+">/);
  });
  test("the overview KPI cards and attention rows are links to the right filtered pages", () => {
    assert.match(main, /<a class="[^"]*kpi[^"]*" href="\/admin\/requests"/);
    assert.match(main, /<a class="card kpi" href="\/admin\/catalog"/);
    assert.match(main, /<a class="card kpi" href="\/admin\/catalog\?f=HIDDEN"/);
    assert.match(main, /<a class="attn" href="\/admin\/catalog\?f=HIDDEN"/);
    assert.match(main, /<a class="attn" href="\/admin\/catalog\?f=UNUSED"/);
    assert.match(main, /<a class="attn" href="\/admin\/requests"/, "a pending category points to «Заявки»");
    assert.ok(main.includes(uk.admin.overview.kpiRequests) && main.includes("Типів послуг: 7") && main.includes("Для нових послуг недоступні"));
    assert.ok(!/oldest|найстаріш/i.test(main), "no oldest-request card");
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

describe("W052 acceptance: no script anywhere, ADMIN_CSP untouched, wording, every new query form behind the gate", () => {
  let w, anon;
  before(async () => { w = await startAdminHarness(); anon = await startAdminHarness({ RENDER_ADMIN_ANON: "1" }); });
  after(() => { w?.stop(); anon?.stop(); });
  const PAGES = ["/admin", "/admin/requests", "/admin/requests?kind=CATEGORY&q=%D0%B1", "/admin/requests?open=CATEGORY:41", "/admin/requests?dlg=approve&id=CATEGORY:41", "/admin/requests?dlg=reject&id=CATEGORY:41",
    "/admin/catalog", "/admin/catalog?f=HIDDEN&q=x", "/admin/catalog?open=NAILS", "/admin/catalog?dlg=rename&cat=BROWS", "/admin/catalog?dlg=disable&cat=BROWS", "/admin/catalog?dlg=enable&cat=MASAZH_NIH", "/admin/catalog?dlg=delete&cat=STRAY", "/admin/catalog?dlg=delete&cat=NAILS"];

  test("no <script, no inline handler, no javascript: URL, no external origin in any admin page or dialog; the CSP header is exactly ADMIN_CSP", async () => {
    for (const path of PAGES) {
      const r = await w.get(path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("content-security-policy"), ADMIN_CSP, path);
      assert.ok(!/<script/i.test(r.html) && !/\son[a-z]+\s*=/i.test(r.html) && !/javascript:/i.test(r.html), path);
      assert.ok(!/(?:src|href|action)="https?:\/\//i.test(r.html), `${path}: external URL`);
      assert.ok(!/<dialog|:target/.test(r.html), `${path}: no native <dialog> / :target`);
    }
  });
  test("no «Приховати / Приховано / Сховайте» (any case, any ending) in uk.json admin copy or in any admin page", async () => {
    const WORD = /прихов|сховайте|сховати/i;
    assert.ok(!WORD.test(JSON.stringify(uk.admin)), "uk.json admin block");
    for (const path of PAGES) assert.ok(!WORD.test((await w.get(path)).html), path);
    const src = readFileSync(join(ROOT, "src/lib/admin/api.ts"), "utf8");
    assert.ok(!WORD.test(src.replace(/\/\/.*$/gm, "")), "api.ts messages");
  });
  test("a non-owner gets 404 on every new query form (dialogs, filters, detail), with no body from the page", async () => {
    for (const path of PAGES) {
      const r = await anon.get(path);
      assert.equal(r.status, 404, path);
      assert.ok(!r.html.includes("Заявки") && !/<form/.test(r.html), path);
    }
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
    assert.equal(importers.length, 4, "the /admin page, /admin/requests (W040), /admin/catalog (W041) and the catch-all route: " + importers.map(base)); // a fifth importer = a public route (or an unlisted admin route) now loads jose
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
