// W049 (WEB-71): category icons in /admin. Part 1: uploadIcon() / safeReturn() / adminCsp() against a fake fetch (zero backend calls on a refused file, exact PUT body, reason -> flash,
// no open redirect, CSP rebuilt from validated origins). Part 2: the BUILT Worker through the harness with the mock backend in B539 + B541 mode (CATALOG_MOCK_GATE=1): <img>-only previews,
// the icon column / strip / NOICON filter, the upload and replace dialog, the request detail and approve panel, the enable panel, the 409 round trip, the CSP header. Nothing leaves localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { adminConfigFrom } from "../src/lib/admin/config.ts";
import { uploadIcon, safeReturn, reasonToFlash, looksLikeSvg, ICON_MAX, BODY_MAX } from "../src/lib/admin/icons.ts";
import { adminCsp, adminImgOrigin, withSecurityHeaders, ADMIN_CSP } from "../src/lib/securityHeaders.ts";
import { adminFetch } from "../src/lib/admin/api.ts";
import { parseCatalogFilter, catalogMatches } from "../src/lib/admin/listQuery.ts";
import { errToFlash as catErr, decide as decideCatalog } from "../src/lib/admin/catalog.ts";
import { decide as decideRequest } from "../src/lib/admin/requests.ts";
import { startAdminHarness } from "./helpers/admin-harness.mjs";
import { uk } from "./helpers/env.mjs";
import { launch, visibleBox } from "./helpers/browser.mjs";

const I = uk.admin.icons;
const cfg = adminConfigFrom({ CF_ACCESS_TEAM_DOMAIN: "beautica.cloudflareaccess.com", CF_ACCESS_AUD: "a", ADMIN_EMAILS: "owner@example.com", INTERNAL_CATALOG_KEY: "k".repeat(40), API_ORIGIN: "https://api.example.test" });
const ACTOR = "owner@example.com";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 12h16" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const SVG2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const q = (loc) => new URL(loc, "https://x.test").searchParams;
// the rebuilt target's param ORDER is not part of the contract: compare path + sorted params
const norm = (loc) => { const u = new URL(loc, "https://x.test"); return `${u.pathname}?${[...u.searchParams].map(([k, v]) => `${k}=${v}`).sort().join("&")}`; };
const main = (h) => h.match(/<body[\s\S]*<\/body>/)?.[0] ?? "";

const multipart = ({ category = "BROWS", ret = "/admin/catalog?dlg=icon&cat=BROWS", file = SVG, filename = "icon.svg", replace = false, pad = 0 } = {}) => {
  const f = new FormData();
  if (category !== null) f.set("category", category);
  f.set("return", ret);
  if (replace) f.set("replace", "1");
  if (file !== null) f.set("icon", new Blob([file], { type: "image/svg+xml" }), filename);
  if (pad) f.set("pad", "x".repeat(pad));
  return f;
};
const req = (form, headers = {}) => new Request("https://beautica.app/admin/icon", { method: "POST", body: form, headers });

async function withBackend(answers, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url).replace("https://api.example.test", ""), method: init.method, actor: init.headers["X-Admin-Actor"], key: init.headers["X-Internal-Key"], body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const [status, body] = answers.shift() ?? [200, { success: true, data: null }];
    return Response.json(body, { status });
  };
  try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
}
const invalid = (reason) => [400, { success: false, data: { code: "ICON_INVALID", reason }, message: "CANARY-BACKEND-MESSAGE" }];

describe("uploadIcon(): the Worker checks the file first, then forwards JSON {svg}", () => {
  test("valid upload: ONE PUT {svg} with the actor; the dialog closes (done=icon_added, dlg/cat dropped, filter kept)", async () => {
    const { out, calls } = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart({ ret: "/admin/catalog?f=NOICON&q=%D0%B1&dlg=icon&cat=BROWS&junk=1" }))));
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.body, c.actor, c.key]), [["PUT", "/api/v1/internal/catalog/categories/BROWS/icon", { svg: SVG }, ACTOR, "k".repeat(40)]]);
    assert.equal(norm(out.location), norm("/admin/catalog?f=NOICON&q=%D0%B1&done=icon_added"));
  });
  test("replace=1 -> icon_replaced; a BOM before <svg is accepted and stripped; <?xml prolog accepted", async () => {
    const a = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart({ replace: true, file: "﻿  " + SVG }))));
    assert.equal(q(a.out.location).get("done"), "icon_replaced");
    assert.equal(a.calls[0].body.svg, "  " + SVG);
    const b = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart({ file: '<?xml version="1.0"?>' + SVG }))));
    assert.equal(b.calls.length, 1);
  });
  test("from an enable / approve panel the panel stays open (now with the icon); approve says «Тепер можна схвалити»", async () => {
    const en = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart({ ret: "/admin/catalog?dlg=enable&cat=BEZ_ICONKY", category: "BEZ_ICONKY" }))));
    assert.equal(norm(en.out.location), norm("/admin/catalog?dlg=enable&cat=BEZ_ICONKY&done=icon_added"));
    const ap = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart({ ret: "/admin/requests?dlg=approve&id=CATEGORY%3A41&open=CATEGORY%3A41", category: "BROW_BAR" }))));
    assert.equal(norm(ap.out.location), norm("/admin/requests?dlg=approve&id=CATEGORY%3A41&open=CATEGORY%3A41&done=icon_added_approve"));
    const rq = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart({ ret: "/admin/requests?dlg=icon&id=CATEGORY%3A41&open=CATEGORY%3A41&kind=CATEGORY", category: "BROW_BAR" }))));
    assert.equal(norm(rq.out.location), norm("/admin/requests?kind=CATEGORY&open=CATEGORY%3A41&done=icon_added"));
  });

  const refused = [
    ["no file field", { file: null }, "ICON_NO_FILE"],
    ["an empty file", { file: "" }, "ICON_NO_FILE"],
    ["not named .svg", { filename: "icon.png" }, "ICON_NOT_SVG"],
    ["named .svg but PNG bytes", { file: "\u0089PNG\r\n\u001a\n" }, "ICON_NOT_SVG"],
    ["plain text named .svg", { file: "hello" }, "ICON_NOT_SVG"],
    ["20 KiB (over 16 KiB)", { file: SVG.replace("</svg>", `<!-- ${"x".repeat(20 * 1024)} --></svg>`) }, "ICON_TOO_LARGE"],
    ["a category that is not a wire name", { category: "brows" }, "FAILED"],
    ["no category", { category: null }, "FAILED"],
  ];
  for (const [label, o, err] of refused) {
    test(`${label}: refused with err=${err} and ZERO backend calls`, async () => {
      const { out, calls } = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart(o))));
      assert.deepEqual(calls, []);
      assert.equal(q(out.location).get("err"), err);
      assert.equal(q(out.location).get("done"), null);
    });
  }
  test("a request whose Content-Length is over 32 KiB is refused before parsing; so is a body that grows past it with no length", async () => {
    const big = multipart({ pad: BODY_MAX + 10 });
    const withLen = await withBackend([], () => uploadIcon(cfg, ACTOR, req(big, { "content-length": String(BODY_MAX + 10) })));
    assert.deepEqual(withLen.calls, []);
    assert.equal(q(withLen.out.location).get("err"), "ICON_TOO_LARGE");
    const noLen = await withBackend([], () => uploadIcon(cfg, ACTOR, req(multipart({ pad: BODY_MAX + 10 }))));
    assert.deepEqual(noLen.calls, []);
    assert.equal(q(noLen.out.location).get("err"), "ICON_TOO_LARGE");
    assert.ok(ICON_MAX < BODY_MAX);
  });
  test("not multipart -> FAILED, zero calls", async () => {
    const { out, calls } = await withBackend([], () => uploadIcon(cfg, ACTOR, new Request("https://beautica.app/admin/icon", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } })));
    assert.deepEqual(calls, []);
    assert.equal(q(out.location).get("err"), "FAILED");
  });

  const reasons = [["TOO_LARGE", "ICON_TOO_LARGE"], ["NOT_SVG", "ICON_BROKEN"], ["BAD_VIEWBOX", "ICON_BAD_VIEWBOX"], ["FORBIDDEN_ELEMENT", "ICON_FORBIDDEN"], ["FORBIDDEN_ATTRIBUTE", "ICON_FORBIDDEN"], ["FORBIDDEN_COLOUR", "ICON_COLOUR"], ["EXTERNAL_REF", "ICON_FORBIDDEN"], ["SOMETHING_NEW", "ICON_BROKEN"]];
  for (const [reason, flash] of reasons) {
    test(`400 ICON_INVALID ${reason} -> err=${flash}, the dialog stays open, the backend text is never echoed`, async () => {
      const { out } = await withBackend([invalid(reason)], () => uploadIcon(cfg, ACTOR, req(multipart())));
      assert.equal(out.location, `/admin/catalog?dlg=icon&cat=BROWS&err=${flash}`);
      assert.ok(!out.location.includes("CANARY"));
      assert.ok(I.err[flash], "copy exists");
    });
  }
  test("other failures: 404, 409, 5xx, a network error map to the generic codes both pages know", async () => {
    for (const [ans, err] of [[[404, { success: false, data: null }], "NOT_FOUND"], [[409, { success: false, data: { code: "CATEGORY_REJECTED" } }], "CONFLICT"], [[503, { success: false, data: null }], "UNAVAILABLE"], [[400, { success: false, data: null }], "BAD_INPUT"], [[409, { success: false, data: { code: "CATALOG_IN_USE" } }], "FAILED"]]) {
      const { out } = await withBackend([ans], () => uploadIcon(cfg, ACTOR, req(multipart())));
      assert.equal(q(out.location).get("err"), err);
    }
  });
  test("reasonToFlash / looksLikeSvg", () => {
    assert.equal(reasonToFlash(undefined), "ICON_BROKEN");
    assert.ok(looksLikeSvg(SVG) && looksLikeSvg("﻿\n<?xml version='1.0'?>") && !looksLikeSvg("<html><svg>") && !looksLikeSvg("<svgx>"));
  });
});

describe("safeReturn(): the 303 target is rebuilt from whitelisted params (no open redirect)", () => {
  const dflt = { path: "/admin/catalog", params: {} };
  test("foreign, absolute, protocol-relative, backslash and non-admin targets give the catalog", () => {
    for (const raw of ["", "https://evil.test/admin/catalog", "//evil.test/admin/catalog", "/\\evil.test", "/admin/other", "/admin", "/admin/catalog/x", "javascript:alert(1)", "admin/catalog", "/%2e%2e/admin/catalog", "/admin/icon"]) assert.deepEqual(safeReturn(raw), dflt, raw);
  });
  test("catalog params: only f / q / p / open / dlg / cat / type survive, each validated", () => {
    const r = safeReturn("/admin/catalog?f=NOICON&q=%20Брови%20&p=3&open=BROWS&dlg=icon&cat=BROWS&type=00010000-0000-4000-8000-000000000001&evil=1&return=https://evil.test");
    assert.deepEqual(r, { path: "/admin/catalog", params: { p: "3", q: "Брови", f: "NOICON", open: "BROWS", dlg: "icon", cat: "BROWS", type: "00010000-0000-4000-8000-000000000001" } });
    assert.deepEqual(safeReturn("/admin/catalog?f=X&p=-1&open=brows&dlg=wipe&cat=<b>&type=nope"), dflt);
  });
  test("requests params: kind / q / p / open / dlg / id / cat", () => {
    assert.deepEqual(safeReturn("/admin/requests?kind=CATEGORY&open=CATEGORY:41&dlg=approve&id=CATEGORY:41&cat=BROW_BAR&f=HIDDEN"), { path: "/admin/requests", params: { kind: "CATEGORY", open: "CATEGORY:41", dlg: "approve", id: "CATEGORY:41", cat: "BROW_BAR" } });
    assert.deepEqual(safeReturn("/admin/requests?dlg=delete&id=x&open=../../etc"), { path: "/admin/requests", params: {} });
  });
});

describe("CSP: img-src = 'self' + only the pinned, validated media origins; never a script-src", () => {
  const M = "https://media.beautica.app";
  const allow = [M];
  test("adminCsp() with no origins is exactly ADMIN_CSP; origins are deduped, pinned and re-validated", () => {
    assert.equal(adminCsp(), ADMIN_CSP);
    assert.equal(adminCsp({ imgOrigins: [] }), ADMIN_CSP);
    const csp = adminCsp({ allow, imgOrigins: [M, M, "http://evil.test", "https://evil.example", "javascript:alert(1)", "data:image/svg+xml,x", "https://u:p@x.test", "*"] });
    assert.ok(csp.includes(`img-src 'self' ${M};`), csp);
    assert.ok(!/script-src|evil|javascript|data:|\*/.test(csp));
    assert.ok(csp.startsWith("default-src 'none';") && csp.includes("form-action 'self'") && csp.includes("frame-ancestors 'none'"));
    assert.equal(adminCsp({ imgOrigins: [M] }), ADMIN_CSP, "no pin = no origins (fail closed)");
  });
  test("adminImgOrigin: only a pinned origin; an off-pin https host (evil.example) and an unpinned loopback are refused", () => {
    assert.equal(adminImgOrigin(`${M}/catalog/x.svg`, allow), M);
    assert.equal(adminImgOrigin("https://evil.example/x.svg", allow), null);
    assert.equal(adminImgOrigin("http://127.0.0.1:8787/x.svg", allow), null, "loopback is not special in production");
    assert.equal(adminImgOrigin("http://127.0.0.1:8787/x.svg", ["http://127.0.0.1:8787"]), "http://127.0.0.1:8787", "allowed only when the pin list carries it (loopback API)");
    for (const bad of ["http://media.beautica.app/x.svg", "javascript:alert(1)", "data:image/svg+xml;base64,AAAA", "//media.beautica.app/x", "https://a:b@media.beautica.app/x", "not a url", 5, null, undefined]) assert.equal(adminImgOrigin(bad, allow), null, String(bad));
  });
  test("the middleware keeps a route's pinned origins, drops anything else it asked for, and never trusts a public-policy answer", () => {
    const own = new Response("x", { headers: { "Content-Security-Policy": adminCsp({ allow, imgOrigins: [M] }) } });
    assert.equal(withSecurityHeaders(own, "/admin/catalog", allow).headers.get("content-security-policy"), adminCsp({ allow, imgOrigins: [M] }));
    const sneaky = new Response("x", { headers: { "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-inline'; img-src 'self' ${M} https://evil.example http://evil.test data: *` } });
    const got = withSecurityHeaders(sneaky, "/admin/catalog", allow).headers.get("content-security-policy");
    assert.equal(got, adminCsp({ allow, imgOrigins: [M] }));
    assert.ok(!got.includes("script-src") && !got.includes("evil"));
    const noPin = new Response("x", { headers: { "Content-Security-Policy": adminCsp({ allow, imgOrigins: [M] }) } });
    assert.equal(withSecurityHeaders(noPin, "/admin/catalog").headers.get("content-security-policy"), ADMIN_CSP, "no pin passed = fail closed");
    const pub = new Response("x", { headers: { "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://public.example" } });
    assert.equal(withSecurityHeaders(pub, "/admin/x", allow).headers.get("content-security-policy"), ADMIN_CSP);
    assert.equal(withSecurityHeaders(new Response("x"), "/admin/x", allow).headers.get("content-security-policy"), ADMIN_CSP);
  });
});

describe("wire contract helpers", () => {
  test("adminFetch carries data.reason of an ICON_INVALID only", async () => {
    const real = globalThis.fetch;
    try {
      globalThis.fetch = async () => Response.json({ success: false, data: { code: "ICON_INVALID", reason: "BAD_VIEWBOX" }, message: "x" }, { status: 400 });
      const a = await adminFetch(cfg, "PUT", "/api/v1/internal/catalog/categories/BROWS/icon", ACTOR, { svg: SVG });
      assert.deepEqual([a.ok, a.status, a.code, a.reason], [false, 400, "ICON_INVALID", "BAD_VIEWBOX"]);
      globalThis.fetch = async () => Response.json({ success: false, data: { code: "OTHER", reason: "BAD_VIEWBOX" }, message: "x" }, { status: 400 });
      assert.equal((await adminFetch(cfg, "PUT", "/api/v1/internal/catalog/categories/BROWS/icon", ACTOR, { svg: SVG })).reason, undefined);
      globalThis.fetch = async () => Response.json({ success: false, data: { code: "ICON_INVALID", reason: "<script>" }, message: "x" }, { status: 400 });
      assert.equal((await adminFetch(cfg, "PUT", "/api/v1/internal/catalog/categories/BROWS/icon", ACTOR, { svg: SVG })).reason, undefined);
    } finally { globalThis.fetch = real; }
  });
  test("NOICON = approved with iconUrl null; an absent iconUrl (pre-B539) never matches", () => {
    assert.equal(parseCatalogFilter("NOICON"), "NOICON");
    const c = (o) => ({ name: "A", displayName: "A", status: "APPROVED", active: true, usageCount: 0, typeCount: 0, ...o });
    assert.equal(catalogMatches(c({ iconUrl: null }), "NOICON"), true);
    assert.equal(catalogMatches(c({ iconUrl: "https://m.test/a.svg" }), "NOICON"), false);
    assert.equal(catalogMatches(c({}), "NOICON"), false);
    assert.equal(catalogMatches(c({ iconUrl: null, status: "PENDING" }), "NOICON"), false);
  });
  test("a 409 CATEGORY_ICON_REQUIRED sends the owner to the panel that carries the upload (approve / enable), a type to nowhere new", async () => {
    const f = (o) => { const x = new FormData(); for (const [k, v] of Object.entries(o)) x.set(k, v); return x; };
    const real = globalThis.fetch;
    try {
      globalThis.fetch = async () => Response.json({ success: false, data: { code: "CATEGORY_ICON_REQUIRED" }, message: "x" }, { status: 409 });
      const a = await decideRequest(cfg, ACTOR, f({ kind: "CATEGORY", id: "41", origName: "Brow bar", name: "Brow bar", origInitialServiceName: "", initialServiceName: "", action: "approve" }));
      assert.equal(q(a.location).get("err"), "CATEGORY_ICON_REQUIRED");
      assert.equal(q(a.location).get("dlg"), "approve");
      assert.equal(q(a.location).get("id"), "CATEGORY:41");
      const e = await decideCatalog(cfg, ACTOR, f({ kind: "category", id: "BROWS", origName: "Брови", name: "Брови", action: "show" }));
      assert.equal(q(e.location).get("dlg"), "enable");
      assert.equal(q(e.location).get("cat"), "BROWS");
      assert.equal(catErr(409, "CATEGORY_ICON_REQUIRED"), "CATEGORY_ICON_REQUIRED");
    } finally { globalThis.fetch = real; }
  });
});

describe("the built Worker, backend in B539 + B541 mode", () => {
  let w, anon, mockOrigin;
  before(async () => { w = await startAdminHarness({ CATALOG_MOCK_GATE: "1", CATALOG_MOCK_ROWS: "10" }); anon = await startAdminHarness({ CATALOG_MOCK_GATE: "1", RENDER_ADMIN_ANON: "1" }); });
  after(() => { w?.stop(); anon?.stop(); });
  const up = async (o) => {
    const r = await fetch(w.base + "/admin/icon", { method: "POST", body: multipart(o), redirect: "manual" });
    return { status: r.status, location: r.headers.get("location") ?? "", headers: r.headers };
  };
  const writes = async (mark) => (await w.calls()).slice(mark).filter((c) => c.method !== "GET");
  const NOICON = ["BEZ_ICONKY", "MASAZH_NIH", "STRAY"];

  test("«Каталог»: icons are <img> only, with a strip, an «Іконка» column and a CSP whose img-src is exactly 'self' + the mock media origin", async () => {
    const r = await w.get("/admin/catalog");
    assert.equal(r.status, 200);
    const imgs = [...r.html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith("/"));
    assert.ok(imgs.length >= 4, "strip + column images");
    mockOrigin = new URL(imgs[0]).origin;
    assert.ok(imgs.every((u) => new URL(u).origin === mockOrigin && /\/media\/catalog\/category-icons\/[A-Z0-9_]+\/[0-9a-f]{16}\.svg$/.test(u)));
    assert.ok(/<img src="http[^"]+" width="48" height="48" alt=""/.test(r.html) && /<img src="http[^"]+" width="24" height="24" alt=""/.test(r.html));
    const csp = r.headers.get("content-security-policy");
    assert.ok(csp.includes(`img-src 'self' ${mockOrigin};`), csp);
    assert.ok(!/script-src/.test(csp) && csp.startsWith("default-src 'none';"));
    assert.ok(!/<object|<embed|<iframe|data:image|M12 3a9 9 0 1 0/.test(r.html), "never inline SVG, object, embed, iframe or a data: URI for an icon");
    assert.ok(!/<script/i.test(r.html));
    assert.ok(r.html.includes(I.stripTitle) && r.html.includes(I.colIcon) && r.html.includes(I.stripHint));
    assert.ok(r.html.includes(I.stripNone.replace("{n}", "3")), "pill «Без іконки: 3»");
  });
  test("a category without an icon: red pill + «Завантажити іконку»; with one: its tile + «Замінити іконку»", async () => {
    const h = (await w.get("/admin/catalog")).html;
    const row = (name) => h.split(`id="cat-${name}"`)[1].split("</tr>")[0];
    assert.ok(row("BEZ_ICONKY").includes(I.none) && row("BEZ_ICONKY").includes("dlg=icon&amp;cat=BEZ_ICONKY") && row("BEZ_ICONKY").includes(`>${I.upload}<`));
    assert.ok(row("BROWS").includes("<img ") && row("BROWS").includes(`>${I.replace}<`) && !row("BROWS").includes(I.none));
    assert.ok(row("NEW_CAT").includes("—") && !row("NEW_CAT").includes("dlg=icon"), "a not-yet-approved category has no icon link");
  });
  test("«Без іконки» chip (?f=NOICON) lists exactly the approved categories with iconUrl null; its count matches", async () => {
    const r = await w.get("/admin/catalog?f=NOICON");
    const ids = [...r.html.matchAll(/id="cat-([A-Z0-9_]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(ids, [...NOICON].sort());
    assert.ok(new RegExp(`${I.fNone}<span class="n">3</span>`).test(r.html));
    assert.ok(r.html.includes('aria-current') || /class="[^"]*selected|aria-pressed|aria-current/.test(r.html));
  });
  test("«Огляд»: the attention row «3 категорії без іконки» links to catalog?f=NOICON", async () => {
    const h = (await w.get("/admin")).html;
    assert.ok(h.includes(I.ovFew.replace("{n}", "3")) && h.includes('href="/admin/catalog?f=NOICON"'));
  });
  test("icon dialog: add (no icon) and replace (current tiles at 48 + 24) with the multipart form, hidden category + return, cancel and save", async () => {
    const a = (await w.get("/admin/catalog?dlg=icon&cat=BEZ_ICONKY")).html;
    assert.ok(a.includes(I.addTitle) && a.includes(I.forCat.replace("{name}", "Без іконки")) && a.includes(I.fileLabel) && a.includes(I.hint) && a.includes(I.save) && a.includes(uk.admin.cancel));
    assert.match(a, /<form method="post" action="\/admin\/icon" enctype="multipart\/form-data"/);
    assert.match(a, /<input type="hidden" name="category" value="BEZ_ICONKY">|<input type="hidden" name="category" value="BEZ_ICONKY"\s*\/?>/);
    assert.match(a, /name="return" value="\/admin\/catalog\?dlg=icon&#38;cat=BEZ_ICONKY"|name="return" value="\/admin\/catalog\?dlg=icon&amp;cat=BEZ_ICONKY"/);
    assert.match(a, /<input[^>]*type="file"[^>]*name="icon"|<input[^>]*name="icon"[^>]*type="file"/);
    assert.ok(!a.includes(I.current) && !a.includes('name="replace"'));
    const b = (await w.get("/admin/catalog?dlg=icon&cat=BROWS")).html;
    assert.ok(b.includes(I.replaceTitle) && b.includes(I.current) && b.includes('name="replace"'));
    assert.ok(/class="ico-pair"[\s\S]*width="48"[\s\S]*width="24"/.test(b.split(I.current)[1]));
  });
  test("an unknown / pending target of the icon dialog: «Не знайдено» / «не схвалено», no panel", async () => {
    for (const u of ["/admin/catalog?dlg=icon&cat=NOPE", "/admin/catalog?dlg=icon&cat=NEW_CAT", "/admin/catalog?dlg=icon"]) {
      const r = await w.get(u);
      assert.equal(r.status, 200, u);
      assert.ok(!r.html.includes('action="/admin/icon"'), u);
    }
  });

  test("upload a valid SVG for STRAY: one PUT {svg} + actor, 303 done=icon_added, STRAY leaves the NOICON list and enters the strip, toast copy", async () => {
    const mark = (await w.calls()).length;
    const r = await up({ category: "STRAY", ret: "/admin/catalog?f=NOICON&dlg=icon&cat=STRAY" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/admin/catalog?f=NOICON&done=icon_added");
    const ws = await writes(mark);
    assert.deepEqual(ws.map((c) => [c.method, c.path, c.body, c.actor]), [["PUT", "/api/v1/internal/catalog/categories/STRAY/icon", { svg: SVG }, "owner@example.com"]]);
    const g = await w.get(r.location);
    assert.ok(main(g.html).includes(I.done.icon_added));
    assert.deepEqual([...g.html.matchAll(/id="cat-([A-Z0-9_]+)"/g)].map((m) => m[1]).sort(), ["BEZ_ICONKY", "MASAZH_NIH"]);
    assert.ok(g.headers.get("content-security-policy").includes(`img-src 'self' ${mockOrigin};`));
  });
  test("replace STRAY's icon: done=icon_replaced; the same bytes again are a backend no-op that still answers 303", async () => {
    const r = await up({ category: "STRAY", ret: "/admin/catalog?dlg=icon&cat=STRAY", file: SVG2, replace: true });
    assert.equal(r.location, "/admin/catalog?done=icon_replaced");
    assert.ok((await w.get(r.location)).html.includes(I.done.icon_replaced));
    const again = await up({ category: "STRAY", ret: "/admin/catalog?dlg=icon&cat=STRAY", file: SVG2, replace: true });
    assert.equal(again.status, 303);
  });
  test("each refusal: its own flash + the dialog open again; the backend rejects what the Worker lets through", async () => {
    const cases = [
      ["script", { file: SVG.replace("</svg>", "<script>alert(1)</script></svg>") }, "ICON_FORBIDDEN", true],
      ["onload", { file: SVG.replace("<svg ", '<svg onload="x()" ') }, "ICON_FORBIDDEN", true],
      ["href", { file: SVG.replace("<path", '<a href="https://evil.test"><path') }, "ICON_FORBIDDEN", true],
      ["viewBox", { file: SVG.replace("0 0 24 24", "0 0 48 48") }, "ICON_BAD_VIEWBOX", true],
      ["colour", { file: SVG.replace("currentColor", "#000") }, "ICON_COLOUR", true],
      ["20 KiB", { file: SVG.replace("</svg>", `<!-- ${"x".repeat(20 * 1024)} --></svg>`) }, "ICON_TOO_LARGE", false],
      ["png name", { filename: "i.png" }, "ICON_NOT_SVG", false],
      ["no file", { file: null }, "ICON_NO_FILE", false],
    ];
    for (const [label, o, err, reachesBackend] of cases) {
      const mark = (await w.calls()).length;
      const r = await up({ category: "BEZ_ICONKY", ret: "/admin/catalog?dlg=icon&cat=BEZ_ICONKY", ...o });
      assert.equal(r.status, 303, label);
      assert.equal(r.location, `/admin/catalog?dlg=icon&cat=BEZ_ICONKY&err=${err}`, label);
      assert.equal((await writes(mark)).length, reachesBackend ? 1 : 0, `${label}: ${reachesBackend ? "the backend is the authority" : "refused by the Worker, zero backend calls"}`);
      const g = await w.get(r.location);
      assert.ok(main(g.html).replace(/&(?:quot|#34);/g, '"').includes(I.err[err]) && g.html.includes('action="/admin/icon"'), label);
      assert.ok(!g.html.includes("CANARY-BACKEND-MESSAGE"));
    }
    const still = (await w.get("/admin/catalog?f=NOICON")).html;
    assert.ok(still.includes('id="cat-BEZ_ICONKY"'), "nothing changed");
  });
  test("a multipart request over 32 KiB is refused with zero backend calls; a foreign return lands on the catalog", async () => {
    const mark = (await w.calls()).length;
    const big = await up({ category: "BEZ_ICONKY", pad: 40 * 1024 });
    assert.equal(big.location, "/admin/catalog?err=ICON_TOO_LARGE");
    const evil = await up({ category: "BEZ_ICONKY", ret: "https://evil.test/admin/requests", file: SVG.replace("0 0 24 24", "0 0 1 1") });
    assert.equal(evil.location, "/admin/catalog?err=ICON_BAD_VIEWBOX");
    const dbl = await up({ category: "BEZ_ICONKY", ret: "//evil.test/x", file: null });
    assert.equal(dbl.location, "/admin/catalog?err=ICON_NO_FILE");
    assert.equal((await writes(mark)).length, 1, "only the viewBox one reached the backend");
  });
  test("GET /admin/icon is 405; a non-owner gets 404 on POST and GET with no body", async () => {
    const g = await fetch(w.base + "/admin/icon", { redirect: "manual" });
    assert.equal(g.status, 405);
    assert.equal(g.headers.get("allow"), "POST");
    const a = await fetch(anon.base + "/admin/icon", { method: "POST", body: multipart(), redirect: "manual" });
    assert.equal(a.status, 404);
    assert.ok(!(await a.text()).includes("<form"));
    assert.equal((await fetch(anon.base + "/admin/icon", { redirect: "manual" })).status, 404);
  });

  test("«Заявки»: a category request without an icon: detail field + upload link, «Схвалити» is a disabled button with the visible reason, the row approve opens the detail", async () => {
    const list = (await w.get("/admin/requests")).html;
    assert.ok(list.includes(I.rowPill));
    const row = list.split('id="req-41"')[1].split("</tr>")[0];
    assert.ok(/aria-disabled="true"/.test(row) && row.includes("open=CATEGORY%3A41") && !row.includes("dlg=approve"), "the row approve is an aria-disabled link to the detail");
    const d = (await w.get("/admin/requests?open=CATEGORY:41")).html;
    assert.ok(d.includes(I.fieldLabel) && d.includes(I.none) && d.includes(`>${I.upload}<`) && d.includes("dlg=icon"));
    assert.match(d, /<button[^>]*disabled[^>]*name="action"[^>]*value="approve"|<button[^>]*name="action"[^>]*value="approve"[^>]*disabled/);
    assert.ok(d.includes(I.approveBlocked));
    const other = (await w.get("/admin/requests?open=CATEGORY:99999")).html;
    assert.ok(!other.includes(I.fieldLabel));
  });
  test("a service-type request has no icon field and its «Схвалити» is untouched", async () => {
    const d = (await w.get("/admin/requests?open=SERVICE_TYPE:5b0f3c1e-2d4a-4c1b-9a77-0a1b2c3d4e5f")).html;
    assert.ok(!d.includes(I.fieldLabel) && !d.includes(I.approveBlocked) && !/<button[^>]*disabled/.test(d));
  });
  test("request icon dialog: upload for BROW_BAR from the detail, back to the detail with the icon attached and «Схвалити» enabled; approve then works", async () => {
    const dlg = (await w.get("/admin/requests?dlg=icon&id=CATEGORY:41&open=CATEGORY:41")).html;
    assert.ok(dlg.includes(I.addTitle) && dlg.includes('action="/admin/icon"') && dlg.includes('value="BROW_BAR"'));
    const r = await up({ category: "BROW_BAR", ret: "/admin/requests?dlg=icon&id=CATEGORY%3A41&open=CATEGORY%3A41" });
    assert.equal(r.location, "/admin/requests?open=CATEGORY%3A41&done=icon_added");
    const d = await w.get(r.location);
    assert.ok(main(d.html).includes(I.done.icon_added) && d.html.includes(I.added) && d.html.includes(I.addedSub) && d.html.includes(`>${I.replace}<`));
    assert.ok(!/<button[^>]*disabled[^>]*value="approve"|<button[^>]*value="approve"[^>]*disabled/.test(d.html) && !d.html.includes(I.approveBlocked));
    assert.ok(d.headers.get("content-security-policy").includes(`img-src 'self' ${mockOrigin};`));
    const mark = (await w.calls()).length;
    const ap = await w.post("/admin/requests", { kind: "CATEGORY", id: "41", origName: "Brow bar", name: "Brow bar", origInitialServiceName: "Ламінування брів", initialServiceName: "Ламінування брів", action: "approve" });
    assert.equal(q(ap.location).get("done"), "approved");
    assert.deepEqual((await writes(mark)).map((c) => [c.method, c.path]), [["POST", "/api/v1/internal/catalog/requests/CATEGORY/41/approve"]]);
  });
  test("stale approve (B541): a category request that still has no icon -> 409 -> the approve panel with the red banner, the inline upload and a disabled confirm; upload -> «Тепер можна схвалити»; approve works", async () => {
    const gen = (await w.get("/admin/requests?kind=CATEGORY")).html.match(/id="req-(\d+)"/g).map((s) => s.slice(8, -1));
    const id = gen.find((x) => x !== "41");
    assert.ok(id, "a second category request exists");
    const p = await w.post("/admin/requests", { kind: "CATEGORY", id, origName: `Категорія ${id - 100}`, name: `Категорія ${id - 100}`, origInitialServiceName: "", initialServiceName: "", action: "approve" });
    assert.equal(q(p.location).get("err"), "CATEGORY_ICON_REQUIRED");
    assert.equal(q(p.location).get("dlg"), "approve");
    const g = await w.get(p.location);
    assert.ok(main(g.html).includes(I.approveRequired) && g.html.includes('action="/admin/icon"') && g.html.includes(I.save));
    assert.match(g.html, /<button[^>]*disabled[^>]*value="approve"|<button[^>]*value="approve"[^>]*disabled/);
  });
  test("enable a category without an icon: the panel shows the upload first and a disabled «Увімкнути»; the stale 409 lands there; after the upload «Іконка є» and the button works", async () => {
    const panel = (await w.get("/admin/catalog?dlg=enable&cat=MASAZH_NIH")).html;
    assert.ok(panel.includes('action="/admin/icon"') && panel.includes(I.enableBlocked));
    assert.match(panel, /<button[^>]*disabled[^>]*value="show"|<button[^>]*value="show"[^>]*disabled/);
    const stale = await w.post("/admin/catalog", { kind: "category", id: "MASAZH_NIH", origName: "Масаж ніг (дубль)", name: "Масаж ніг (дубль)", action: "show" });
    assert.equal(q(stale.location).get("err"), "CATEGORY_ICON_REQUIRED");
    assert.equal(q(stale.location).get("dlg"), "enable");
    const sp = await w.get(stale.location);
    assert.ok(sp.html.includes(I.enableRequired) && sp.html.includes('action="/admin/icon"'));
    const r = await up({ category: "MASAZH_NIH", ret: "/admin/catalog?dlg=enable&cat=MASAZH_NIH" });
    assert.equal(r.location, "/admin/catalog?dlg=enable&cat=MASAZH_NIH&done=icon_added");
    const after = await w.get(r.location);
    assert.ok(after.html.includes(I.enableHas) && !after.html.includes(I.enableBlocked) && !after.html.includes('action="/admin/icon"'));
    assert.ok(!/<button[^>]*disabled[^>]*value="show"|<button[^>]*value="show"[^>]*disabled/.test(after.html));
    const ok = await w.post("/admin/catalog", { kind: "category", id: "MASAZH_NIH", origName: "Масаж ніг (дубль)", name: "Масаж ніг (дубль)", action: "show" });
    assert.equal(q(ok.location).get("done"), "shown");
  });
  test("a category WITH an icon: the enable panel is the ordinary one", async () => {
    const p = (await w.get("/admin/catalog?dlg=enable&cat=BROWS")).html;
    assert.ok(!p.includes('action="/admin/icon"') && !p.includes(I.enableBlocked));
  });

  // A real browser under the real CSP: the icon <img>s must actually LOAD (a CSP that dropped the media origin would block them and only a browser notices).
  for (const width of [360, 1280]) {
    test(`in a browser @${width}: every icon image loads under the CSP (no violation), no horizontal overflow, the upload action is visible`, async () => {
      const browser = await launch();
      try {
        const context = await browser.newContext({ viewport: { width, height: 900 } }); // the mock media host is the harness's own 127.0.0.1 origin: nothing leaves the machine
        const page = await context.newPage();
        const csp = [];
        page.on("console", (m) => /Content Security Policy|Refused to load/i.test(m.text()) && csp.push(m.text()));
        await page.goto(`${w.base}/admin/catalog`, { waitUntil: "load" });
        const imgs = page.locator("img[src^='http']");
        assert.ok((await imgs.count()) >= 4, "strip + column icons");
        await page.waitForFunction(() => [...document.querySelectorAll("img[src^='http']")].every((i) => i.complete));
        const broken = await imgs.evaluateAll((is) => is.filter((i) => i.naturalWidth === 0).map((i) => i.src));
        assert.deepEqual(broken, [], "images blocked or failed");
        assert.deepEqual(csp, [], "CSP violations");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow");
        assert.ok(await visibleBox(page.getByRole("link", { name: I.upload }).first()), "«Завантажити іконку» is reachable");
        await context.close();
      } finally {
        await browser.close();
      }
    });
  }
});

describe("the built Worker, backend WITHOUT iconUrl (pre-B539): the W052 pages are unchanged and nothing is gated", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  test("no icon column, strip, chip or field; «Схвалити» stays enabled; the CSP is exactly ADMIN_CSP", async () => {
    for (const [path, banned] of [["/admin/catalog", [I.stripTitle, I.colIcon, `${I.fNone}<span class="n">`]], ["/admin/requests?open=CATEGORY:41", [I.fieldLabel, I.approveBlocked]], ["/admin/catalog?dlg=enable&cat=MASAZH_NIH", [I.enableBlocked]], ["/admin", [I.ovFew.replace("{n}", "0")]]]) {
      const r = await w.get(path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("content-security-policy"), ADMIN_CSP, path);
      for (const b of banned) assert.ok(!r.html.includes(b), `${path}: ${b}`);
      assert.ok(!/<img src="http/.test(r.html), path);
      assert.ok(!/<button[^>]*disabled/.test(r.html.replace(/<button[^>]*aria-label[^>]*disabled/g, "")) || path === "/admin", path);
    }
  });
});
