// W041 QA: /admin/catalog. Part 1: decide() / listCatalog() against a fake fetch (bodies, call counts, flash mapping, caps). Part 2: the BUILT Worker through the
// harness (scripts/render-admin.mjs + the mock catalog backend): rendered markup (delete disabled while used, two-step confirm, no script) and write flows checked
// on the backend call log, plus a 200-category catalog (paging, subrequest count, page weight). Nothing leaves localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminConfigFrom } from "../src/lib/admin/config.ts";
import { decide as decideFull, listCatalog, errToFlash, PAGE_SIZE, DONE_CODES, ERR_CODES } from "../src/lib/admin/catalog.ts";
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
  test("delete without confirm=1 -> err=FAILED and no backend DELETE (the confirm step is not UI-only)", async () => {
    for (const k of [cat, typ]) {
      const r = await withBackend([[204, null]], () => decide(cfg, ACTOR, form({ ...k, action: "delete" })));
      assert.deepEqual(r.calls, []);
      assert.match(r.out, /^\/admin\/catalog\?err=FAILED&open=BROWS&card=/);
    }
    const r = await withBackend([[204, null]], () => decide(cfg, ACTOR, form({ ...cat, action: "delete", confirm: "0" })));
    assert.deepEqual(r.calls, []);
  });
  test("delete -> DELETE with the actor and no body; success redirects with «deleted» (a deleted category is not kept open)", async () => {
    const a = await withBackend([[204, null]], () => decide(cfg, ACTOR, form({ ...cat, action: "delete", confirm: "1" })));
    assert.deepEqual(a.calls.map((c) => [c.method, c.url, c.body, c.actor, c.key]), [["DELETE", `${P}categories/BROWS`, undefined, ACTOR, "k".repeat(40)]]);
    assert.equal(a.out, "/admin/catalog?done=deleted");
    const b = await withBackend([[204, null]], () => decide(cfg, ACTOR, form({ ...typ, action: "delete", confirm: "1" })));
    assert.equal(b.out, "/admin/catalog?done=deleted&open=BROWS");
  });
  test("409 CATALOG_IN_USE: the counts ride in the query (digits only), nothing else of the body", async () => {
    const a = await withBackend([typedErr("CATALOG_IN_USE", { serviceTypes: 2, definitions: 0, pendingSuggestions: 1, secret: "x" })], () => decide(cfg, ACTOR, form({ ...cat, action: "delete", confirm: "1" })));
    const u = q(a.out);
    assert.equal(u.get("err"), "CATALOG_IN_USE");
    assert.equal(u.get("st"), "2"); assert.equal(u.get("ps"), "1"); assert.equal(u.has("df"), false);
    assert.ok(!a.out.includes("CANARY") && !a.out.includes("secret"));
    const b = await withBackend([typedErr("CATALOG_IN_USE", { definitions: 3 })], () => decide(cfg, ACTOR, form({ ...typ, action: "delete", confirm: "1" })));
    assert.equal(q(b.out).get("df"), "3");
    const c = await withBackend([typedErr("CATALOG_IN_USE")], () => decide(cfg, ACTOR, form({ ...typ, action: "delete", confirm: "1" })));
    assert.equal(c.out, "/admin/catalog?err=CATALOG_IN_USE&open=BROWS", "the FK backstop sends the code without counts");
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
    for (const f of ["src/pages/admin/catalog.astro", "src/lib/admin/catalog.ts", "src/components/AdminCatalogRow.astro"]) assert.ok(!/https?:\/\//.test(readFileSync(`${ROOT}/${f}`, "utf8")), f);
  });
});

describe("built Worker: sample catalog", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const main = (h) => h.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
  const writes = async (from = 0) => (await w.calls()).slice(from).filter((c) => c.method !== "GET");

  test("renders 200 with the admin headers; no script; 6 categories, each a <details>", async () => {
    const r = await w.get("/admin/catalog");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
    assert.ok(!/<script/i.test(r.html));
    assert.match(r.html, new RegExp(`<h1[^>]*>${uk.admin.catalog.h1}</h1>`));
    assert.equal((main(r.html).match(/<details\b[^>]*class="[^"]*\bcat\b/g) ?? []).length, 6);
    assert.ok(main(r.html).includes("BROWS") && main(r.html).includes(">Брови<"));
  });
  test("usage counts are shown; the hidden and pending chips appear", async () => {
    const m = main((await w.get("/admin/catalog")).html);
    assert.ok(m.includes("Послуг: 40 · Типів: 3"), "NAILS usage + type count");
    assert.ok(m.includes(`>${uk.admin.catalog.hidden}<`) && m.includes(`>${uk.admin.catalog.pending}<`));
  });
  test("delete: disabled while counts are above 0; an enabled two-step <details> confirm only when 0", async () => {
    const m = main((await w.get("/admin/catalog?open=NAILS")).html);
    const forms = [...m.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((f) => f[0]);
    const row = (kind, id) => forms.find((f) => f.includes(`name="kind" value="${kind}"`) && f.includes(`name="id" value="${id}"`));
    const nails = row("category", "NAILS"), stray = row("category", "STRAY");
    assert.match(nails, /<button[^>]*\bdisabled\b[^>]*>\s*Видалити/, "used category: disabled button");
    assert.ok(!/value="delete"/.test(nails), "no submit that deletes");
    assert.ok(nails.includes(uk.admin.catalog.deleteBlocked));
    assert.match(stray, /<details[^>]*class="[^"]*\bdel\b[\s\S]*?<button[^>]*name="action"[^>]*value="delete"[^>]*>\s*Так, видалити назавжди/);
    assert.ok(!/<details[^>]*\bopen\b[^>]*class="[^"]*\bdel\b/.test(stray), "the confirm starts closed");
    const typeUsed = row("type", "00020000-0000-4000-8000-000000000001"), typeFree = row("type", "00020000-0000-4000-8000-000000000003");
    assert.match(typeUsed, /<button[^>]*\bdisabled\b/); assert.ok(!/value="delete"/.test(typeUsed));
    assert.ok(/value="delete"/.test(typeFree));
    assert.ok(forms.every((f) => (f.match(/name="action" value="save"/g) ?? []).length === 1 && f.indexOf('value="save"') < (f.indexOf('value="delete"') < 0 ? Infinity : f.indexOf('value="delete"'))), "Save is the first submit (Enter saves)");
  });
  test("types load only for the open category; the others get a «Показати типи» link that keeps the page", async () => {
    const closed = main((await w.get("/admin/catalog")).html);
    assert.ok(!closed.includes('name="kind" value="type"'), "no type form without ?open=");
    assert.ok(closed.includes('href="/admin/catalog?open=NAILS"') && closed.includes("Показати типи (3)"));
    const open = main((await w.get("/admin/catalog?open=NAILS")).html);
    assert.equal((open.match(/name="kind" value="type"/g) ?? []).length, 3);
    assert.ok(open.includes("Манікюр") && !open.includes("Корекція брів"));
  });
  test("a PENDING category has no actions; a hidden one offers «Показати»; a visible one «Приховати»", async () => {
    const forms = [...main((await w.get("/admin/catalog")).html).matchAll(/<form\b[\s\S]*?<\/form>/g)].map((f) => f[0]);
    assert.ok(!forms.some((f) => f.includes('name="id" value="NEW_CAT"')));
    assert.ok(forms.find((f) => f.includes('name="id" value="MASAZH_NIH"')).includes('value="show"'));
    assert.ok(forms.find((f) => f.includes('name="id" value="BROWS"')).includes('value="hide"'));
  });
  test("hide BROWS: one PATCH {active:false} with the actor; the next GET shows the chip, the «hidden» banner and keeps it open", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post("/admin/catalog", { kind: "category", id: "BROWS", origName: "Брови", name: "Брови", action: "hide" });
    assert.equal(r.status, 303);
    assert.equal(q(r.location).get("done"), "hidden");
    const ws = await writes(mark);
    assert.deepEqual(ws.map((c) => [c.method, c.path, c.body, c.actor]), [["PATCH", `${P}categories/BROWS`, { active: false }, "owner@example.com"]]);
    const g = await w.get(r.location);
    assert.ok(main(g.html).includes(uk.admin.catalog.flash.hidden));
    assert.match(g.html, /<details[^>]*\bopen\b[^>]*class="[^"]*\bcat\b|<details[^>]*class="[^"]*\bcat\b[^"]*"[^>]*\bopen\b/);
  });
  test("rename a type (uk + en): one PATCH; a duplicate name is the typed TYPE_EXISTS banner and the typed value stays in the field", async () => {
    const id = "00020000-0000-4000-8000-000000000001";
    const ok = await w.post("/admin/catalog", { kind: "type", id, cat: "NAILS", origName: "Манікюр", name: "Манікюр класичний", origNameEn: "Manicure", nameEn: "Classic manicure", action: "save" });
    assert.equal(q(ok.location).get("done"), "saved");
    const dup = await w.post("/admin/catalog", { kind: "type", id, cat: "NAILS", origName: "Манікюр класичний", name: "Педикюр", origNameEn: "Classic manicure", nameEn: "Classic manicure", action: "save" });
    assert.equal(q(dup.location).get("err"), "TYPE_EXISTS");
    assert.ok(!dup.location.includes("Педикюр") && !decodeURIComponent(dup.location).includes("Педикюр"));
    const cookie = dup.setCookie.split(";")[0];
    assert.match(dup.setCookie, /HttpOnly/i); assert.match(dup.setCookie, /SameSite=Strict/i); assert.match(dup.setCookie, /Path=\/admin\/catalog/i);
    const g = await w.get(dup.location, { cookie });
    const text = main(g.html);
    assert.ok(text.includes(uk.admin.catalog.flash.TYPE_EXISTS));
    const field = (h) => new RegExp(`id="n-type-${id}"[^>]*value="([^"]*)"`).exec(main(h))?.[1];
    assert.equal(field(g.html), "Педикюр", "the typed value is back in that row's field");
    assert.ok(!text.includes("CANARY"));
    assert.equal(field((await w.get(dup.location)).html), "Манікюр класичний", "without the cookie the field shows the stored name again (one-shot)");
  });
  test("delete a used category: refused 409, the banner names the counts, nothing changes; an unused one is gone", async () => {
    const r = await w.post("/admin/catalog", { kind: "category", id: "NAILS", origName: "Нігті", name: "Нігті", action: "delete", confirm: "1" });
    assert.equal(q(r.location).get("err"), "CATALOG_IN_USE");
    const g = await w.get(r.location);
    assert.ok(main(g.html).includes("Використовується: 40 послуг, 3 типів — приховайте замість видалення."), main(g.html).slice(0, 600));
    assert.ok(!g.html.includes("CANARY"));
    assert.ok(main((await w.get("/admin/catalog")).html).includes('name="id" value="NAILS"'));
    const mark = (await w.calls()).length;
    const d = await w.post("/admin/catalog", { kind: "category", id: "STRAY", origName: "Зайва", name: "Зайва", action: "delete", confirm: "1" });
    assert.equal(q(d.location).get("done"), "deleted");
    assert.deepEqual((await writes(mark)).map((c) => [c.method, c.path, c.actor]), [["DELETE", `${P}categories/STRAY`, "owner@example.com"]]);
    assert.ok(!main((await w.get("/admin/catalog")).html).includes('name="id" value="STRAY"'));
  });
  test("a used type: «Використовується: N послуг»; un-hiding a category with no icon: the B541 copy; pending: CATEGORY_NOT_APPROVED", async () => {
    const t = await w.post("/admin/catalog", { kind: "type", id: "00020000-0000-4000-8000-000000000001", cat: "NAILS", origName: "x", name: "x", action: "delete", confirm: "1" });
    assert.ok(main((await w.get(t.location)).html).includes("Використовується: 30 послуг —"));
    const i = await w.post("/admin/catalog", { kind: "category", id: "BEZ_ICONKY", origName: "Без іконки", name: "Без іконки", action: "show" });
    assert.ok(main((await w.get(i.location)).html).includes(uk.admin.catalog.flash.CATEGORY_ICON_REQUIRED));
    const n = await w.post("/admin/catalog", { kind: "category", id: "NEW_CAT", origName: "Нова категорія", name: "Нова категорія", action: "delete", confirm: "1" });
    assert.equal(q(n.location).get("err"), "CATEGORY_NOT_APPROVED");
  });
  test("an unknown category: 404 banner; GET with garbage query values shows no banner", async () => {
    const r = await w.post("/admin/catalog", { kind: "category", id: "GONE", origName: "x", name: "x", action: "delete", confirm: "1" });
    assert.equal(q(r.location).get("err"), "NOT_FOUND");
    const g = await w.get("/admin/catalog?err=<script>&done=x&st=zz&p=abc&open=%3Cb%3E");
    assert.equal(g.status, 200);
    assert.ok(!/<script/i.test(g.html) && !/class="[^"]*flash/.test(g.html));
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
  const details = (h) => (h.match(/<details\b[^>]*class="[^"]*\bcat\b/g) ?? []).length;

  test("page 1: 10 categories, a pager, ONE backend call, a light HTML (< 60 KB)", async () => {
    const mark = (await w.calls()).length;
    const r = await w.get("/admin/catalog");
    assert.equal(r.status, 200);
    assert.equal(details(r.html), PAGE_SIZE);
    assert.match(r.html, new RegExp(`aria-label="${uk.admin.catalog.pager}"`));
    assert.match(r.html, /1 \/ 20/);
    const gets = (await w.calls()).slice(mark).filter((c) => c.method === "GET");
    assert.deepEqual(gets.map((c) => c.path), [`${P}categories`]);
    assert.ok(Buffer.byteLength(r.html) < 60_000, `${Buffer.byteLength(r.html)} bytes`);
    const o = await w.get("/admin/catalog?open=GEN_0001");
    assert.equal((o.html.match(/name="kind" value="type"/g) ?? []).length, 12);
    assert.ok(Buffer.byteLength(o.html) < 100_000, `open category: ${Buffer.byteLength(o.html)} bytes`);
  });
  test("page 20 is the last; a page past the end redirects to it; garbage p is page 1", async () => {
    assert.equal(details((await w.get("/admin/catalog?p=20")).html), PAGE_SIZE);
    const past = await w.get("/admin/catalog?p=99");
    assert.equal(past.status, 303);
    assert.equal(q(past.location).get("p"), "20");
    assert.equal(details((await w.get("/admin/catalog?p=abc")).html), PAGE_SIZE);
  });
  test("an action on page 3 returns to page 3", async () => {
    const r = await w.post("/admin/catalog", { kind: "category", id: "GEN_0030", origName: "Категорія 0030", name: "Категорія 0030", action: "hide", p: "3" });
    assert.equal(q(r.location).get("p"), "3");
  });
});
