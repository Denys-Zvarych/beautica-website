// W041 QA: /admin/catalog. Part 1: decide() / listCatalog() against a fake fetch (bodies, call counts, flash mapping, caps). Part 2: the BUILT Worker through the
// harness (scripts/render-admin.mjs + the mock catalog backend): rendered markup (delete disabled while used, two-step confirm, no script) and write flows checked
// on the backend call log, plus a 200-category catalog (paging, subrequest count, page weight). Nothing leaves localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminConfigFrom } from "../src/lib/admin/config.ts";
import { decide as decideFull, listCatalog, loadCategories, errToFlash, PAGE_SIZE, DONE_CODES, ERR_CODES } from "../src/lib/admin/catalog.ts";
import { catalogMatches, filterCatalog, parseCatalogFilter, parseQuery, paginate, withQuery, pluralUk } from "../src/lib/admin/listQuery.ts";
import { adminFetch } from "../src/lib/admin/api.ts";
import { startAdminHarness } from "./helpers/admin-harness.mjs";
import { ROOT, uk } from "./helpers/env.mjs";

const cfg = adminConfigFrom({ CF_ACCESS_TEAM_DOMAIN: "beautica.cloudflareaccess.com", CF_ACCESS_AUD: "a", ADMIN_EMAILS: "owner@example.com", INTERNAL_CATALOG_KEY: "k".repeat(40), API_ORIGIN: "https://api.example.test" });
const ACTOR = "owner@example.com";
const P = "/api/v1/internal/catalog/";
const TID = "00010000-0000-4000-8000-000000000001";
const decide = async (...a) => (await decideFull(...a)).location;
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const typedErr = (code, extra = {}) => [409, { success: false, data: { code, ...extra }, message: "CANARY" }];

async function withBackend(answers, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url).replace("https://api.example.test", ""), method: init.method, actor: init.headers["X-Admin-Actor"], key: init.headers["X-Internal-Key"], body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const [status, body] = answers.shift() ?? [200, { success: true, data: null }];
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  };
  try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
}
// delete now verifies the typed name against the backend's own list first (W052 audit): the GETs answered before the write
const CATS = [200, { success: true, data: [{ name: "BROWS", displayName: "Брови", status: "APPROVED", active: true, usageCount: 0, typeCount: 1 }] }];
const TYPES = [200, { success: true, data: [{ id: TID, slug: "k", nameUk: "Корекція", nameEn: "", active: true, usageCount: 0 }] }];
const pre = (k) => (k.kind === "type" ? [CATS, TYPES] : [CATS]);
const writes = (r) => r.calls.filter((c) => c.method !== "GET");
const cat = { kind: "category", id: "BROWS", origName: "Брови", name: "Брови" };
const typ = { kind: "type", id: TID, cat: "BROWS", origName: "Корекція", name: "Корекція", origNameEn: "", nameEn: "" };
const q = (loc) => new URL(loc, "https://x.test").searchParams;

describe("decide(): one backend call per action, exact bodies, actor on every write", () => {
  test("rename category -> PATCH {displayName} only", async () => {
    const { out, calls } = await withBackend([], () => decide(cfg, ACTOR, form({ ...cat, name: "Брови й вії", action: "save" })));
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.body, c.actor]), [["PATCH", `${P}categories/BROWS`, { displayName: "Брови й вії" }, ACTOR]]);
    assert.equal(out, "/admin/catalog?done=saved&open=BROWS");
  });
  test("rename type: only the changed names go out; a cleared English name is sent as \"\"", async () => {
    const a = await withBackend([], () => decide(cfg, ACTOR, form({ ...typ, name: "Нова", action: "save" })));
    assert.deepEqual(a.calls[0].body, { nameUk: "Нова" });
    const b = await withBackend([], () => decide(cfg, ACTOR, form({ ...typ, origNameEn: "Shaping", nameEn: "", action: "save" })));
    assert.deepEqual(b.calls[0].body, { nameEn: "" });
    const c = await withBackend([], () => decide(cfg, ACTOR, form({ ...typ, name: "Нова", nameEn: "New", action: "save" })));
    assert.deepEqual(c.calls[0].body, { nameUk: "Нова", nameEn: "New" });
    assert.equal(c.calls[0].url, `${P}service-types/${TID}`);
    assert.equal(c.out, "/admin/catalog?done=saved&open=BROWS");
  });
  test("nothing changed -> no backend call, «unchanged»", async () => {
    const { out, calls } = await withBackend([], () => decide(cfg, ACTOR, form({ ...cat, action: "save" })));
    assert.equal(calls.length, 0);
    assert.equal(out, "/admin/catalog?done=unchanged&open=BROWS");
  });
  test("hide / show -> PATCH {active:false|true}; the typed name is ignored", async () => {
    const h = await withBackend([], () => decide(cfg, ACTOR, form({ ...cat, name: "Інше", action: "hide" })));
    assert.deepEqual(h.calls.map((c) => [c.method, c.body]), [["PATCH", { active: false }]]);
    assert.equal(h.out, "/admin/catalog?done=hidden&open=BROWS");
    const s = await withBackend([], () => decide(cfg, ACTOR, form({ ...typ, action: "show" })));
    assert.deepEqual(s.calls.map((c) => [c.method, c.url, c.body]), [["PATCH", `${P}service-types/${TID}`, { active: true }]]);
    assert.equal(s.out, "/admin/catalog?done=shown&open=BROWS");
  });
  test("delete without the typed name (W052 D4: replaces confirm=1) -> err=NAME_MISMATCH and no backend DELETE; a wrong or differently-cased name is refused too", async () => {
    for (const k of [cat, typ]) {
      for (const extra of [{}, { confirmName: "" }, { confirmName: "не те" }, { confirmName: k.origName.toLowerCase() === k.origName ? k.origName.toUpperCase() : k.origName.toLowerCase() }, { confirm: "1" }]) {
        const r = await withBackend([...pre(k), [204, null]], () => decide(cfg, ACTOR, form({ ...k, action: "delete", ...extra })));
        assert.deepEqual(writes(r), [], JSON.stringify(extra));
        assert.match(r.out, /^\/admin\/catalog\?err=NAME_MISMATCH&open=BROWS&card=/);
      }
    }
    const blank = await withBackend([CATS, [204, null]], () => decide(cfg, ACTOR, form({ ...cat, origName: "  ", confirmName: "  ", action: "delete" })));
    assert.deepEqual(writes(blank), [], "an empty panel name never matches an empty typed name");
  });
  test("delete -> DELETE with the actor and no body; success redirects with «deleted» (a deleted category is not kept open)", async () => {
    const a = await withBackend([CATS, [204, null]], () => decide(cfg, ACTOR, form({ ...cat, action: "delete", confirmName: "Брови" })));
    assert.deepEqual(writes(a).map((c) => [c.method, c.url, c.body, c.actor, c.key]), [["DELETE", `${P}categories/BROWS`, undefined, ACTOR, "k".repeat(40)]]);
    assert.equal(a.out, "/admin/catalog?done=deleted");
    const b = await withBackend([CATS, TYPES, [204, null]], () => decide(cfg, ACTOR, form({ ...typ, action: "delete", confirmName: "Корекція" })));
    assert.equal(b.out, "/admin/catalog?done=deleted&open=BROWS");
  });
  test("forged origName == confirmName != the real name: NAME_MISMATCH, zero writes; unknown target: NOT_FOUND", async () => {
    for (const k of [cat, typ]) {
      const r = await withBackend([...pre(k), [204, null]], () => decide(cfg, ACTOR, form({ ...k, origName: "Підроблена", action: "delete", confirmName: "Підроблена" })));
      assert.deepEqual(writes(r), []);
      assert.match(r.out, /err=NAME_MISMATCH/);
    }
    const gone = await withBackend([[200, { success: true, data: [] }], [204, null]], () => decide(cfg, ACTOR, form({ ...cat, action: "delete", confirmName: "Брови" })));
    assert.deepEqual(writes(gone), []);
    assert.match(gone.out, /err=NOT_FOUND/);
  });
  test("409 CATALOG_IN_USE: the counts ride in the query (digits only), nothing else of the body", async () => {
    const a = await withBackend([CATS, typedErr("CATALOG_IN_USE", { serviceTypes: 2, definitions: 0, pendingSuggestions: 1, secret: "x" })], () => decide(cfg, ACTOR, form({ ...cat, action: "delete", confirmName: "Брови" })));
    const u = q(a.out);
    assert.equal(u.get("err"), "CATALOG_IN_USE");
    assert.equal(u.get("st"), "2"); assert.equal(u.get("ps"), "1"); assert.equal(u.has("df"), false);
    assert.ok(!a.out.includes("CANARY") && !a.out.includes("secret"));
    const b = await withBackend([CATS, TYPES, typedErr("CATALOG_IN_USE", { definitions: 3 })], () => decide(cfg, ACTOR, form({ ...typ, action: "delete", confirmName: "Корекція" })));
    assert.equal(q(b.out).get("df"), "3");
    const c = await withBackend([CATS, TYPES, typedErr("CATALOG_IN_USE")], () => decide(cfg, ACTOR, form({ ...typ, action: "delete", confirmName: "Корекція" })));
    assert.equal(c.out, `/admin/catalog?err=CATALOG_IN_USE&open=BROWS&type=${TID}`, "the FK backstop sends the code without counts; a type names itself so the page can open its «Видалити не можна» panel");
  });
  test("every typed 409 maps to its own flash code; unknown 409 / 400 / 404 / 5xx / network are generic", () => {
    for (const code of ["TYPE_EXISTS", "CATEGORY_NAME_EXISTS", "CATEGORY_NOT_APPROVED", "CATEGORY_ICON_REQUIRED", "CATALOG_IN_USE"]) assert.equal(errToFlash(409, code), code);
    assert.equal(errToFlash(409, "WHATEVER"), "CONFLICT");
    assert.equal(errToFlash(400, "TYPE_EXISTS"), "BAD_INPUT", "a typed code is read from a 409 only");
    assert.equal(errToFlash(404, ""), "NOT_FOUND");
    assert.equal(errToFlash(503, ""), "UNAVAILABLE");
    assert.equal(errToFlash(0, ""), "UNAVAILABLE");
    assert.equal(errToFlash(401, ""), "FAILED");
  });
  test("a failed rename keeps the typed names for the re-render in the cookie payload, never in the URL", async () => {
    const { out } = await withBackend([typedErr("TYPE_EXISTS")], () => decideFull(cfg, ACTOR, form({ ...typ, name: "Дубль", nameEn: "Dup", action: "save" })));
    assert.equal(q(out.location).get("err"), "TYPE_EXISTS");
    assert.equal(q(out.location).get("card"), `t:${TID}`);
    assert.ok(!decodeURIComponent(out.location).includes("Дубль"));
    assert.deepEqual(JSON.parse(out.typed), ["Дубль", "Dup"]);
  });
  test("empty name and > 300 code points: BAD_INPUT with zero backend calls (300 passes)", async () => {
    const a = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...cat, name: "   ", action: "save" })));
    assert.equal(a.calls.length, 0); assert.match(a.out.location, /err=BAD_INPUT/);
    const b = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...cat, name: "😀".repeat(301), action: "save" })));
    assert.equal(b.calls.length, 0); assert.ok([...JSON.parse(b.out.typed)[0]].length <= 120);
    const c = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...typ, nameEn: "😀".repeat(301), action: "save" })));
    assert.equal(c.calls.length, 0);
    const d = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...cat, name: "😀".repeat(300), action: "save" })));
    assert.equal(d.calls.length, 1);
  });
  test("tampered input never reaches the backend: bad kind / action / wire name / uuid / a type without its category", async () => {
    for (const bad of [{ ...cat, kind: "x", action: "save" }, { ...cat, action: "nuke" }, { ...cat, id: "../x", action: "delete" }, { ...cat, id: "brows", action: "delete" }, { ...typ, id: "42", action: "delete" }, { ...typ, cat: "", action: "delete" }, { ...typ, cat: "a/b", action: "delete" }]) {
      const { out, calls } = await withBackend([], () => decide(cfg, ACTOR, form(bad)));
      assert.equal(calls.length, 0, JSON.stringify(bad));
      assert.equal(out, "/admin/catalog?err=FAILED");
    }
  });
  test("the page number survives the redirect (p > 1 only)", async () => {
    const a = await withBackend([], () => decide(cfg, ACTOR, form({ ...cat, action: "hide", p: "3" })));
    assert.equal(q(a.out).get("p"), "3");
    const b = await withBackend([], () => decide(cfg, ACTOR, form({ ...cat, action: "hide", p: "1" })));
    assert.equal(q(b.out).has("p"), false);
  });
  test("every flash code has Ukrainian copy", () => {
    for (const c of [...DONE_CODES, ...ERR_CODES]) assert.ok(uk.admin.catalog.flash[c], c);
    assert.ok(uk.admin.catalog.flash.inUse.includes("{details}") && uk.admin.catalog.flash.inUseServices.includes("{n}"));
  });
});

describe("adminFetch: counts of a CATALOG_IN_USE 409", () => {
  test("only non-negative integers next to the code are kept; other codes carry none", async () => {
    const a = await withBackend([typedErr("CATALOG_IN_USE", { serviceTypes: -1, definitions: 4, pendingSuggestions: "9" })], () => adminFetch(cfg, "DELETE", `${P}categories/X1`, ACTOR));
    assert.deepEqual(a.out.counts, { definitions: 4 });
    const b = await withBackend([typedErr("TYPE_EXISTS", { definitions: 4 })], () => adminFetch(cfg, "PATCH", `${P}service-types/${TID}`, ACTOR, {}));
    assert.equal("counts" in b.out, false);
  });
  test("a 204 is a success", async () => {
    const a = await withBackend([[204, null]], () => adminFetch(cfg, "DELETE", `${P}service-types/${TID}`, ACTOR));
    assert.equal(a.out.ok, true);
  });
});

describe("listCatalog(): paging and subrequest budget", () => {
  const catList = (n) => ({ success: true, data: Array.from({ length: n }, (_, i) => ({ name: `C_${String(i).padStart(3, "0")}`, displayName: `Кат ${String(i).padStart(3, "0")}`, status: "APPROVED", active: true, usageCount: 0, typeCount: i % 2 })) });
  test("one list call + ONE type call, for the open category only; the others carry no types (a light page, 2 calls whatever the catalog size)", async () => {
    const answers = [[200, catList(25)], [200, { success: true, data: [{ id: TID, slug: "s", nameUk: "Т", nameEn: null, active: true, usageCount: 0 }] }]];
    const { out, calls } = await withBackend(answers, () => listCatalog(cfg, ACTOR, 1, "C_001"));
    assert.equal(out.ok, true);
    assert.equal(out.rows.length, PAGE_SIZE);
    assert.equal(out.total, 25); assert.equal(out.totalPages, 3);
    assert.deepEqual(calls.map((c) => c.url), [`${P}categories`, `${P}categories/C_001/service-types`]);
    assert.ok(calls.every((c) => c.method === "GET" && c.actor === ACTOR));
    assert.equal(out.rows[1].types.length, 1);
    assert.ok(out.rows.filter((r) => r.types !== undefined).length === 1, "only the open category is loaded");
    const none = await withBackend([[200, catList(25)]], () => listCatalog(cfg, ACTOR, 1));
    assert.equal(none.calls.length, 1, "no open category: no type call");
    const empty = await withBackend([[200, catList(25)]], () => listCatalog(cfg, ACTOR, 1, "C_000"));
    assert.equal(empty.calls.length, 1, "an open category with 0 types costs no call");
    assert.deepEqual(empty.out.rows[0].types, []);
    const off = await withBackend([[200, catList(25)]], () => listCatalog(cfg, ACTOR, 1, "C_024"));
    assert.equal(off.calls.length, 1, "an open category on another page is ignored");
  });
  test("page 3 holds the remainder; a page past the end is empty (the page redirects)", async () => {
    const a = await withBackend([[200, catList(25)]], () => listCatalog(cfg, ACTOR, 3));
    assert.equal(a.out.rows.length, 5);
    const b = await withBackend([[200, catList(25)]], () => listCatalog(cfg, ACTOR, 9));
    assert.equal(b.out.rows.length, 0); assert.equal(b.out.total, 25);
  });
  test("a failed type list marks only that category; a failed category list is a load error", async () => {
    const a = await withBackend([[200, catList(2)], [500, { success: false }]], () => listCatalog(cfg, ACTOR, 1, "C_001"));
    assert.equal(a.out.rows[1].types, null); assert.equal(a.out.rows[0].types, undefined);
    const b = await withBackend([[503, { success: false }]], () => listCatalog(cfg, ACTOR, 1));
    assert.deepEqual(b.out, { ok: false, err: "UNAVAILABLE" });
  });
  });

describe("source pins", () => {
  const page = readFileSync(`${ROOT}/src/pages/admin/catalog.astro`, "utf8");
  test("the route uses requireActor and returns its Response before rendering; no script, no client directive", () => {
    assert.match(page, /const actor = requireActor\(Astro\.locals\);\s*\nif \(actor instanceof Response\) return actor;/);
    assert.ok(!/<script|client:/.test(page));
    assert.ok(page.includes("export const prerender = false;"));
  });
  test("no hard-coded origin in the catalog code", () => {
    for (const f of ["src/pages/admin/catalog.astro", "src/lib/admin/catalog.ts", "src/lib/admin/listQuery.ts", "src/components/admin/AdminShell.astro", "src/components/admin/AdminDialog.astro"]) assert.ok(!/https?:\/\//.test(readFileSync(`${ROOT}/${f}`, "utf8")), f);
  });
});

describe("W052 list helpers: filter predicates, query parsing, paging", () => {
  const c = (name, status, active, usageCount, typeCount) => ({ name, displayName: name.toLowerCase(), status, active, usageCount, typeCount });
  const set = [c("LIVE_USED", "APPROVED", true, 3, 1), c("HID_USED", "APPROVED", false, 2, 0), c("PEND", "PENDING", true, 0, 0), c("REJ", "REJECTED", true, 0, 0), c("FREE", "APPROVED", true, 0, 0), c("HID_FREE", "APPROVED", false, 0, 0), c("TYPED_ONLY", "APPROVED", true, 0, 2)];
  const names = (f, q = "") => filterCatalog(set, f, q).map((x) => x.name);
  test("LIVE = approved and active; HIDDEN = approved and not active; PENDING; UNUSED = approved, usage 0, types 0", () => {
    assert.deepEqual(names("LIVE"), ["LIVE_USED", "FREE", "TYPED_ONLY"]);
    assert.deepEqual(names("HIDDEN"), ["HID_USED", "HID_FREE"]);
    assert.deepEqual(names("PENDING"), ["PEND"]);
    assert.deepEqual(names("UNUSED"), ["FREE", "HID_FREE"]);
  });
  test("REJECTED shows only under «Усі»", () => {
    assert.ok(names("ALL").includes("REJ"));
    for (const f of ["LIVE", "HIDDEN", "PENDING", "UNUSED"]) assert.ok(!names(f).includes("REJ"), f);
    assert.equal(catalogMatches(set[3], "ALL"), true);
  });
  test("q matches the display name and the wire code, case-insensitively (Ukrainian letters too)", () => {
    assert.deepEqual(names("ALL", "hid_"), ["HID_USED", "HID_FREE"]);
    assert.deepEqual(filterCatalog([c("NAILS", "APPROVED", true, 0, 0), { ...c("X", "APPROVED", true, 0, 0), displayName: "Манікюр" }], "ALL", "МАНІК").map((x) => x.name), ["X"]);
  });
  test("an unknown filter is «Усі»; q is trimmed and cut at 100 code points; p keeps parsePage semantics via paginate clamping", () => {
    assert.equal(parseCatalogFilter("NOPE"), "ALL"); assert.equal(parseCatalogFilter(undefined), "ALL"); assert.equal(parseCatalogFilter("HIDDEN"), "HIDDEN");
    assert.equal(parseQuery("  a  "), "a"); assert.equal([...parseQuery("😀".repeat(150))].length, 100); assert.equal(parseQuery(null), "");
    const pg = paginate(Array.from({ length: 25 }, (_, i) => i), 99, 10);
    assert.deepEqual([pg.page, pg.pages, pg.from, pg.to, pg.slice.length], [3, 3, 21, 25, 5]);
    assert.deepEqual(paginate([], 1, 10), { slice: [], page: 1, pages: 1, total: 0, from: 0, to: 0 });
  });
  test("withQuery drops empty params; pluralUk gives one / few / many", () => {
    assert.equal(withQuery("/a", { f: false, q: "", p: undefined, open: "X" }), "/a?open=X");
    assert.equal(withQuery("/a", {}), "/a");
    const f = ["категорія", "категорії", "категорій"];
    assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 111].map((n) => pluralUk(n, f)), [f[0], f[1], f[2], f[2], f[2], f[0], f[1], f[2], f[2]]);
  });
  test("loadCategories(): one backend call, sorted by display name in Ukrainian", async () => {
    const data = ["Яблуко", "Арка", "Їжак", "Бар"].map((n, i) => ({ name: `C_${i}`, displayName: n, status: "APPROVED", active: true, usageCount: 0, typeCount: 0 }));
    const { out, calls } = await withBackend([[200, { success: true, data }]], () => loadCategories(cfg, ACTOR));
    assert.equal(calls.length, 1);
    assert.deepEqual(out.cats.map((x) => x.displayName), ["Арка", "Бар", "Їжак", "Яблуко"]);
  });
});

describe("built Worker: sample catalog", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const main = (h) => h.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
  const page = (h) => h.match(/<body[\s\S]*<\/body>/)?.[0] ?? ""; // main + the sidebar + the flash toast
  const writes = async (from = 0) => (await w.calls()).slice(from).filter((c) => c.method !== "GET");
  const rows = (h) => (main(h).match(/<tr id="cat-/g) ?? []).length;
  const hrefs = (h) => [...main(h).matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  const chipN = (h, label) => Number(new RegExp(`${label}<span class="n">(\\d+)</span>`).exec(main(h))?.[1]);

  test("renders 200 with the admin headers; no script; 6 categories as table rows; the sidebar and h1", async () => {
    const r = await w.get("/admin/catalog");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.ok(!/<script/i.test(r.html));
    assert.match(r.html, new RegExp(`<h1[^>]*>${uk.admin.catalog.h1}</h1>`));
    assert.equal(rows(r.html), 6);
    assert.ok(main(r.html).includes("BROWS") && main(r.html).includes("<b>Брови</b>"));
    assert.match(r.html, /<a class="nav-i" href="\/admin\/catalog" aria-current="page"/);
  });
  test("usage cells and status pills: bold «у N послугах» + «майстрів і салонів»; 0 = «Ніде не використано»; hidden and pending pills", async () => {
    const m = main((await w.get("/admin/catalog")).html);
    assert.ok(m.includes("<b>у 40 послугах</b>") && m.includes(`<small>${uk.admin.catalog.usageSub}</small>`), "NAILS usage");
    assert.ok(m.includes(`>${uk.admin.catalog.notUsed}<`));
    assert.ok(m.includes(`>${uk.admin.catalog.statusHidden}<`) && m.includes(`>${uk.admin.catalog.statusPending}<`) && m.includes(`>${uk.admin.catalog.statusLive}<`));
    assert.match(m, /title="У скількох послугах майстрів і салонів вибрано цей пункт"/);
  });
  test("every chip yields its set (counts ignore q): fixture = 3 live, 2 disabled, 1 pending, 2 unused", async () => {
    const all = (await w.get("/admin/catalog")).html;
    assert.deepEqual(["Усі", "Активні", "Вимкнені", "Очікують", "Ніде не використано"].map((l) => chipN(all, l)), [6, 3, 2, 1, 2]);
    const ids = (h) => [...main(h).matchAll(/<tr id="cat-([A-Z_]+)"/g)].map((x) => x[1]).sort();
    assert.deepEqual(ids((await w.get("/admin/catalog?f=LIVE")).html), ["BROWS", "NAILS", "STRAY"]);
    assert.deepEqual(ids((await w.get("/admin/catalog?f=HIDDEN")).html), ["BEZ_ICONKY", "MASAZH_NIH"]);
    assert.deepEqual(ids((await w.get("/admin/catalog?f=PENDING")).html), ["NEW_CAT"]);
    assert.deepEqual(ids((await w.get("/admin/catalog?f=UNUSED")).html), ["BEZ_ICONKY", "STRAY"]);
    assert.equal(rows((await w.get("/admin/catalog?f=NOPE")).html), 6, "unknown filter = «Усі»");
  });
  test("q matches the name and the code; chips keep q; no result shows «Нічого не знайдено» + reset", async () => {
    const a = (await w.get("/admin/catalog?q=нігт")).html, b = (await w.get("/admin/catalog?q=brows")).html;
    assert.equal(rows(a), 1); assert.ok(main(a).includes('id="cat-NAILS"'));
    assert.equal(rows(b), 1); assert.ok(main(b).includes('id="cat-BROWS"'));
    assert.ok(hrefs(a).some((h) => h.includes("f=LIVE") && h.includes("q=%D0%BD%D1%96%D0%B3%D1%82")), "chip links carry q");
    assert.equal(chipN(a, "Усі"), 6, "chip counts ignore q");
    const none = (await w.get("/admin/catalog?q=zzzz")).html;
    assert.ok(main(none).includes(uk.admin.catalog.noneFound) && hrefs(none).includes("/admin/catalog"));
    assert.match(main(a), /<form class="search" method="get" action="\/admin\/catalog"/);
  });
  test("no inline actions: every row action is a link to ?dlg=...; a PENDING category has none; types stay closed without ?open=", async () => {
    const closed = main((await w.get("/admin/catalog")).html);
    assert.ok(!closed.includes('name="kind" value="type"') && !/<tr class="sub"/.test(closed));
    const h = hrefs(`<main>${closed}</main>`).filter((x) => x.includes("dlg="));
    assert.ok(h.some((x) => /dlg=rename&cat=BROWS$/.test(x)) && h.some((x) => /dlg=disable&cat=BROWS$/.test(x)) && h.some((x) => /dlg=enable&cat=MASAZH_NIH$/.test(x)) && h.some((x) => /dlg=delete&cat=STRAY$/.test(x)));
    assert.ok(!h.some((x) => x.includes("cat=NEW_CAT")), "pending: no actions, a link to «Заявки»");
    assert.ok(closed.includes(uk.admin.catalog.reviewInRequests));
    const open = main((await w.get("/admin/catalog?open=NAILS")).html);
    assert.equal((open.match(/<small lang="en">/g) ?? []).length, 3);
    assert.ok(open.includes("Манікюр") && !open.includes("Корекція брів"));
  });
  test("every dialog opens by URL and cancel returns to the same filtered list: rename (cat + type), disable, enable, delete confirm, delete blocked", async () => {
    const dlg = async (u) => (await w.get(u)).html;
    const rc = await dlg("/admin/catalog?f=LIVE&dlg=rename&cat=BROWS");
    assert.match(rc, /<section class="dlg"[^>]*role="dialog"[^>]*aria-labelledby="dlg-t"/);
    assert.ok(rc.includes(uk.admin.catalog.renameCat) && rc.includes('name="origName" value="Брови"') && rc.includes('name="f" value="LIVE"'));
    assert.ok(rc.includes('href="/admin/catalog?f=LIVE"'), "scrim / cancel go back to the filtered list");
    assert.ok(rc.includes("Код «BROWS» не змінюється") && rc.includes("Нова назва одразу зʼявиться у 12 послугах"));
    const rt = await dlg("/admin/catalog?dlg=rename&cat=NAILS&type=00020000-0000-4000-8000-000000000001&open=NAILS");
    assert.ok(rt.includes(uk.admin.catalog.renameType) && rt.includes('name="nameEn" ') && rt.includes('name="cat" value="NAILS"'));
    const dis = await dlg("/admin/catalog?dlg=disable&cat=BROWS");
    assert.ok(dis.includes("Вимкнути «Брови»?") && dis.includes("(зараз вибрано у 12 послугах майстрів і салонів)") && dis.includes('value="hide"'));
    const en = await dlg("/admin/catalog?dlg=enable&cat=MASAZH_NIH");
    assert.ok(en.includes("Увімкнути «Масаж ніг (дубль)»?") && en.includes(uk.admin.catalog.enableBody) && en.includes('value="show"'));
    const del = await dlg("/admin/catalog?dlg=delete&cat=STRAY");
    assert.ok(del.includes("Видалити «Зайва» назавжди?") && del.includes('name="confirmName"') && del.includes('value="delete"') && !del.includes("Видалити не можна"));
    const blocked = await dlg("/admin/catalog?dlg=delete&cat=NAILS");
    assert.ok(blocked.includes(uk.admin.catalog.blockedTitle) && blocked.includes("у 40 послугах") && blocked.includes("3 типи") && !blocked.includes('name="confirmName"'));
    assert.ok(hrefs(blocked).some((x) => /dlg=disable&cat=NAILS$/.test(x)), "the blocked panel offers «Вимкнути»");
    const blockedType = await dlg("/admin/catalog?dlg=delete&cat=NAILS&type=00020000-0000-4000-8000-000000000001&open=NAILS");
    assert.ok(blockedType.includes(uk.admin.catalog.blockedTitle) && blockedType.includes("у 30 послугах"));
  });
  test("an unknown or malformed dialog target: the list plus a flash, no panel, no 5xx; a pending category has no dialogs", async () => {
    for (const u of ["/admin/catalog?dlg=rename&cat=NOPE", "/admin/catalog?dlg=delete&cat=%3Cb%3E", "/admin/catalog?dlg=rename&cat=NAILS&type=00020000-0000-4000-8000-0000000000ff&open=NAILS", "/admin/catalog?dlg=rename&cat=NEW_CAT"]) {
      const r = await w.get(u);
      assert.equal(r.status, 200, u);
      assert.ok(!/<section class="dlg"/.test(r.html) && !/<script/i.test(r.html), u);
      assert.match(r.html, /class="flash [^"]*bad[^"]*"/, u);
    }
    assert.ok(!/<section class="dlg"/.test((await w.get("/admin/catalog?dlg=nuke&cat=BROWS")).html));
  });
  test("hide BROWS: one PATCH {active:false} with the actor; the next GET shows the pill, the «Вимкнено» toast and keeps the card open", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post("/admin/catalog", { kind: "category", id: "BROWS", origName: "Брови", name: "Брови", action: "hide" });
    assert.equal(r.status, 303);
    assert.equal(q(r.location).get("done"), "hidden");
    const ws = await writes(mark);
    assert.deepEqual(ws.map((c) => [c.method, c.path, c.body, c.actor]), [["PATCH", `${P}categories/BROWS`, { active: false }, "owner@example.com"]]);
    const g = await w.get(r.location);
    assert.ok(page(g.html).includes(uk.admin.catalog.flash.hidden));
    assert.match(g.html, /<div class="flash ok toast" role="status"/);
    assert.match(g.html, /class="exp on"/);
    assert.match(g.html, /href="\/admin\/catalog"[^>]*aria-label="Закрити"|aria-label="Закрити"[^>]*href="\/admin\/catalog\?open=BROWS"|href="\/admin\/catalog\?open=BROWS"[^>]*aria-label="Закрити"/, "the toast's × drops done/err");
  });
  test("rename a type (uk + en): one PATCH; a duplicate name re-opens its rename panel with the TYPE_EXISTS toast and the typed value stays in the field (one-shot cookie)", async () => {
    const id = "00020000-0000-4000-8000-000000000001";
    const ok = await w.post("/admin/catalog", { kind: "type", id, cat: "NAILS", origName: "Манікюр", name: "Манікюр класичний", origNameEn: "Manicure", nameEn: "Classic manicure", action: "save" });
    assert.equal(q(ok.location).get("done"), "saved");
    const dup = await w.post("/admin/catalog", { kind: "type", id, cat: "NAILS", origName: "Манікюр класичний", name: "Педикюр", origNameEn: "Classic manicure", nameEn: "Classic manicure", action: "save" });
    assert.equal(q(dup.location).get("err"), "TYPE_EXISTS");
    assert.ok(!dup.location.includes("Педикюр") && !decodeURIComponent(dup.location).includes("Педикюр"));
    const cookie = dup.setCookie.split(";")[0];
    assert.match(dup.setCookie, /HttpOnly/i); assert.match(dup.setCookie, /SameSite=Strict/i); assert.match(dup.setCookie, /Path=\/admin\/catalog/i);
    const g = await w.get(dup.location, { cookie });
    assert.ok(page(g.html).includes(uk.admin.catalog.flash.TYPE_EXISTS));
    assert.match(g.html, /<section class="dlg"/);
    const field = (h) => /id="nn"[^>]*value="([^"]*)"/.exec(h)?.[1];
    assert.equal(field(g.html), "Педикюр", "the typed value is back in the rename panel's field");
    assert.ok(!g.html.includes("CANARY"));
    assert.equal(field((await w.get(dup.location)).html), "Манікюр класичний", "without the cookie the field shows the stored name again (one-shot)");
  });
  test("delete a used category: refused 409 -> the blocked panel names the counts, nothing changes; the typed-name delete of an unused one works", async () => {
    const r = await w.post("/admin/catalog", { kind: "category", id: "NAILS", origName: "Нігті", name: "Нігті", action: "delete", confirmName: "Нігті" });
    assert.equal(q(r.location).get("err"), "CATALOG_IN_USE");
    const g = await w.get(r.location);
    assert.ok(page(g.html).includes("Використовується: 40 послуг, 3 типів — вимкніть замість видалення."), page(g.html).slice(0, 600));
    assert.ok(g.html.includes(uk.admin.catalog.blockedTitle) && g.html.includes("у 40 послугах") && g.html.includes("3 типи"));
    assert.ok(!g.html.includes("CANARY"));
    assert.ok(main((await w.get("/admin/catalog")).html).includes('id="cat-NAILS"'));
    const mark = (await w.calls()).length;
    const d = await w.post("/admin/catalog", { kind: "category", id: "STRAY", origName: "Зайва", name: "Зайва", action: "delete", confirmName: "Зайва" });
    assert.equal(q(d.location).get("done"), "deleted");
    assert.deepEqual((await writes(mark)).map((c) => [c.method, c.path, c.actor]), [["DELETE", `${P}categories/STRAY`, "owner@example.com"]]);
    assert.ok(!main((await w.get("/admin/catalog")).html).includes('id="cat-STRAY"'));
  });
  test("a wrong typed name: 303 back to the delete panel with «Назва не збігається», NO backend DELETE, the row stays", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post("/admin/catalog", { kind: "category", id: "BEZ_ICONKY", origName: "Без іконки", name: "x", action: "delete", confirmName: "без іконки" });
    assert.equal(q(r.location).get("err"), "NAME_MISMATCH");
    assert.deepEqual(await writes(mark), []);
    const g = await w.get(r.location);
    assert.ok(page(g.html).includes(uk.admin.catalog.flash.NAME_MISMATCH));
    assert.ok(g.html.includes('name="confirmName"') && /name="confirmName"[^>]*aria-invalid="true"/.test(g.html), "the confirm panel is open again");
    assert.ok(main((await w.get("/admin/catalog")).html).includes('id="cat-BEZ_ICONKY"'));
  });
  test("a used type: «Використовується: N послуг» and the type's blocked panel; un-hiding a category with no icon: the B541 copy; pending: CATEGORY_NOT_APPROVED", async () => {
    const id = "00020000-0000-4000-8000-000000000001";
    const t = await w.post("/admin/catalog", { kind: "type", id, cat: "NAILS", origName: "Манікюр класичний", name: "Манікюр класичний", action: "delete", confirmName: "Манікюр класичний" });
    assert.equal(q(t.location).get("type"), id);
    const tg = await w.get(t.location);
    assert.ok(page(tg.html).includes("Використовується: 30 послуг —") && tg.html.includes(uk.admin.catalog.blockedTitle));
    const i = await w.post("/admin/catalog", { kind: "category", id: "BEZ_ICONKY", origName: "Без іконки", name: "Без іконки", action: "show" });
    assert.ok(page((await w.get(i.location)).html).includes(uk.admin.catalog.flash.CATEGORY_ICON_REQUIRED));
    const n = await w.post("/admin/catalog", { kind: "category", id: "NEW_CAT", origName: "Нова категорія", name: "Нова категорія", action: "delete", confirmName: "Нова категорія" });
    assert.equal(q(n.location).get("err"), "CATEGORY_NOT_APPROVED");
  });
  test("an unknown category: 404 banner; GET with garbage query values shows no banner", async () => {
    const r = await w.post("/admin/catalog", { kind: "category", id: "GONE", origName: "x", name: "x", action: "delete", confirmName: "x" });
    assert.equal(q(r.location).get("err"), "NOT_FOUND");
    const g = await w.get("/admin/catalog?err=<script>&done=x&st=zz&p=abc&open=%3Cb%3E&f=%3Cb%3E&q=%3Cscript%3E");
    assert.equal(g.status, 200);
    const noAttrs = g.html.replace(/value="[^"]*"/g, ""); // the search box echoes q inside a quoted attribute (the quote is escaped): harmless text, never markup
    assert.ok(!/<script/i.test(noAttrs) && !/class="flash/.test(g.html));
  });
  test("the search text is reflected only through escaping", async () => {
    const g = await w.get(`/admin/catalog?q=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
    assert.ok(g.html.includes('value="&quot;><img src=x onerror=alert(1)>"'), "the quote is escaped: the text stays inside its attribute");
    const noAttrs = g.html.replace(/value="[^"]*"/g, "");
    assert.ok(!/<img src=x/i.test(noAttrs) && !/\sonerror=/i.test(noAttrs));
  });
  test("a PUT is 405", async () => {
    const r = await fetch(`${w.base}/admin/catalog`, { method: "PUT" });
    assert.equal(r.status, 405);
  });
});

describe("built Worker: a 200-category catalog", () => {
  let w;
  before(async () => { w = await startAdminHarness({ CATALOG_MOCK_CATEGORIES: "200" }); });
  after(() => w?.stop());
  const rows = (h) => (h.match(/<tr id="cat-/g) ?? []).length;
  const pagerLinks = (h) => [...(/<nav[^>]*class="[^"]*pager[^"]*"[\s\S]*?<\/nav>/.exec(h)?.[0] ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

  test("page 1: 10 categories, a pager, ONE categories call + ONE sidebar-count call, a light HTML (< 80 KB)", async () => {
    const mark = (await w.calls()).length;
    const r = await w.get("/admin/catalog");
    assert.equal(r.status, 200);
    assert.equal(rows(r.html), PAGE_SIZE);
    assert.match(r.html, new RegExp(`aria-label="${uk.admin.catalog.pager}"`));
    assert.match(r.html, /1 \/ 20/);
    const gets = (await w.calls()).slice(mark).filter((c) => c.method === "GET").map((c) => c.path.replace(/\?.*/, ""));
    assert.deepEqual(gets.sort(), [`${P}categories`, `${P}requests`], "the list + the sidebar count (D5), nothing else");
    assert.ok(Buffer.byteLength(r.html) < 80_000, `${Buffer.byteLength(r.html)} bytes`);
    const o = await w.get("/admin/catalog?open=GEN_0001");
    assert.equal((o.html.match(/<small lang="en">/g) ?? []).length, 12);
    assert.ok(Buffer.byteLength(o.html) < 120_000, `open category: ${Buffer.byteLength(o.html)} bytes`);
  });
  test("page 20 is the last; a page past the end redirects to it; garbage p is page 1", async () => {
    assert.equal(rows((await w.get("/admin/catalog?p=20")).html), PAGE_SIZE);
    const past = await w.get("/admin/catalog?p=99");
    assert.equal(past.status, 303);
    assert.equal(q(past.location).get("p"), "20");
    assert.equal(rows((await w.get("/admin/catalog?p=abc")).html), PAGE_SIZE);
  });
  test("paging keeps the filter and the search; the filtered total and «Показано a–b із N» follow the filter", async () => {
    const h = (await w.get("/admin/catalog?f=HIDDEN&p=2")).html; // GEN_0000.. every 5th is disabled: 39 + 2 fixture ones = 41 -> 5 pages
    assert.ok(pagerLinks(h).every((l) => l.includes("f=HIDDEN")), pagerLinks(h).join(" "));
    assert.ok(h.includes("Показано 11–20 із 41"));
    const s = (await w.get("/admin/catalog?q=Категорія&p=2")).html;
    assert.ok(pagerLinks(s).every((l) => l.includes("q=")), pagerLinks(s).join(" "));
  });
  test("an action on page 3 returns to page 3, with its filter", async () => {
    const r = await w.post("/admin/catalog", { kind: "category", id: "GEN_0030", origName: "Категорія 0030", name: "Категорія 0030", action: "hide", p: "3" });
    assert.equal(q(r.location).get("p"), "3");
    const f = await w.post("/admin/catalog", { kind: "category", id: "GEN_0030", origName: "Категорія 0030", name: "Категорія 0030", action: "show", p: "2", f: "HIDDEN", q: "Кат" });
    assert.deepEqual([q(f.location).get("p"), q(f.location).get("f"), q(f.location).get("q")], ["2", "HIDDEN", "Кат"]);
  });
});
