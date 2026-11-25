// W041 QA, route level (complements tests/admin-catalog.test.mjs, which covers decide()/listCatalog() and the sample page): real form POSTs through the BUILT Worker
// (scripts/render-admin.mjs + scripts/lib/catalog-mock.mjs), judged on the mock backend's call log. Covers: the server-side delete confirm, every typed 409 banner,
// hide / unhide round trip, the ?open= deep link, pager bounds, the auth headers of every backend call, and the no-JS CSP. Nothing leaves localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { errToFlash } from "../src/lib/admin/catalog.ts";
import { ADMIN_CSP } from "../src/lib/securityHeaders.ts";
import { startAdminHarness } from "./helpers/admin-harness.mjs";
import { ROOT, uk } from "./helpers/env.mjs";

const F = uk.admin.catalog.flash;
const P = "/api/v1/internal/catalog/";
const OWNER = "owner@example.com";
const CATALOG_KEY = "test-catalog-key-0000000000000000000";
const q = (loc) => new URL(loc, "https://x.test").searchParams;
const main = (h) => h.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
const cat = (id, name, extra = {}) => ({ kind: "category", id, origName: name, name, ...extra });
const typ = (id, c, name, extra = {}) => ({ kind: "type", id, cat: c, origName: name, name, origNameEn: "", nameEn: "", ...extra });
const NAILS_FREE_TYPE = "00020000-0000-4000-8000-000000000003"; // «Невикористаний тип», usage 0
const NAILS_USED_TYPE = "00020000-0000-4000-8000-000000000001";
const BROWS_ARCHIVED_TYPE = "00010000-0000-4000-8000-000000000003"; // inactive, usage 0

describe("route: delete needs confirm=1 on the server, not only in the UI", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const writesSince = async (mark) => (await w.calls()).slice(mark).filter((c) => c.method !== "GET");
  const cases = [
    ["category, no confirm field", cat("STRAY", "Зайва"), {}],
    ["category, confirm=0", cat("STRAY", "Зайва"), { confirm: "0" }],
    ["category, confirm empty", cat("STRAY", "Зайва"), { confirm: "" }],
    ["type, no confirm field", typ(NAILS_FREE_TYPE, "NAILS", "Невикористаний тип"), {}],
    ["type, confirm=0", typ(NAILS_FREE_TYPE, "NAILS", "Невикористаний тип"), { confirm: "0" }],
  ];
  for (const [label, base, extra] of cases) {
    test(`${label}: 303 to err=FAILED and ZERO backend calls`, async () => {
      const mark = (await w.calls()).length;
      const r = await w.post("/admin/catalog", { ...base, action: "delete", ...extra });
      assert.equal(r.status, 303);
      assert.equal(q(r.location).get("err"), "FAILED");
      assert.equal(q(r.location).get("done"), null);
      assert.deepEqual((await w.calls()).slice(mark), [], "the backend must not be called at all");
      assert.ok(main((await w.get(r.location)).html).includes(F.FAILED));
    });
  }
  test("after every refused attempt the rows still exist (nothing deleted)", async () => {
    const m = main((await w.get("/admin/catalog?open=NAILS")).html);
    assert.ok(m.includes('name="id" value="STRAY"') && m.includes(NAILS_FREE_TYPE));
  });
  test("confirm=1: 303 to done=deleted and exactly ONE DELETE per row (category, then type)", async () => {
    let mark = (await w.calls()).length;
    const c = await w.post("/admin/catalog", { ...cat("STRAY", "Зайва"), action: "delete", confirm: "1" });
    assert.equal(c.status, 303); assert.equal(q(c.location).get("done"), "deleted");
    assert.deepEqual((await writesSince(mark)).map((x) => [x.method, x.path, x.body]), [["DELETE", `${P}categories/STRAY`, null]]);
    mark = (await w.calls()).length;
    const t = await w.post("/admin/catalog", { ...typ(NAILS_FREE_TYPE, "NAILS", "Невикористаний тип"), action: "delete", confirm: "1" });
    assert.equal(q(t.location).get("done"), "deleted");
    assert.deepEqual((await writesSince(mark)).map((x) => [x.method, x.path]), [["DELETE", `${P}service-types/${NAILS_FREE_TYPE}`]]);
    assert.ok(!main((await w.get("/admin/catalog")).html).includes('name="id" value="STRAY"'));
  });
});

describe("route: typed 409 banners, one per code", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const banner = async (loc, cookie) => main((await w.get(loc, cookie ? { cookie } : {})).html);

  test("CATALOG_IN_USE on a category with types but no usage: names the types only", async () => {
    const r = await w.post("/admin/catalog", { ...cat("MASAZH_NIH", "Масаж ніг (дубль)"), action: "delete", confirm: "1" });
    assert.equal(q(r.location).get("err"), "CATALOG_IN_USE");
    assert.equal(q(r.location).get("st"), "1");
    const text = await banner(r.location);
    assert.ok(text.includes("Використовується: 1 типів — приховайте замість видалення."), text.replace(/\s+/g, " ").slice(0, 900));
    assert.ok(!/Використовується: \d+ послуг/.test(text), "no services count when there is no usage");
  });
  test("CATALOG_IN_USE on a category with types AND usage: both counts, in the spec order", async () => {
    const r = await w.post("/admin/catalog", { ...cat("BROWS", "Брови"), action: "delete", confirm: "1" });
    assert.ok((await banner(r.location)).includes("Використовується: 12 послуг, 3 типів — приховайте замість видалення."));
  });
  test("CATEGORY_NAME_EXISTS: renaming a category onto another's name (case-insensitive) shows its banner and keeps the typed name in the field", async () => {
    const r = await w.post("/admin/catalog", { ...cat("BROWS", "Брови", { name: "нігті" }), action: "save" });
    assert.equal(q(r.location).get("err"), "CATEGORY_NAME_EXISTS");
    assert.ok(!decodeURIComponent(r.location).includes("нігті"), "the typed value is not in the URL");
    const cookie = r.setCookie.split(";")[0];
    const g = await w.get(r.location, { cookie });
    assert.ok(main(g.html).includes(F.CATEGORY_NAME_EXISTS));
    assert.ok(main(g.html).includes('value="нігті"'));
  });
  test("TYPE_EXISTS: renaming a type onto a sibling's name", async () => {
    const r = await w.post("/admin/catalog", { ...typ(NAILS_USED_TYPE, "NAILS", "Манікюр", { name: "Педикюр" }), action: "save" });
    assert.equal(q(r.location).get("err"), "TYPE_EXISTS");
    assert.ok((await banner(r.location)).includes(F.TYPE_EXISTS));
  });
  test("TYPE_EXISTS: un-hiding is not special-cased, a hidden-type rename onto an existing name is the same banner", async () => {
    const r = await w.post("/admin/catalog", { ...typ(BROWS_ARCHIVED_TYPE, "BROWS", "Архівний тип", { name: "Корекція брів" }), action: "save" });
    assert.equal(q(r.location).get("err"), "TYPE_EXISTS");
  });
  test("CATEGORY_NOT_APPROVED: a pending category cannot be hidden or renamed", async () => {
    for (const action of ["hide", "save"]) {
      const r = await w.post("/admin/catalog", { ...cat("NEW_CAT", "Нова категорія", action === "save" ? { name: "Інша" } : {}), action });
      assert.equal(q(r.location).get("err"), "CATEGORY_NOT_APPROVED", action);
      assert.ok((await banner(r.location)).includes(F.CATEGORY_NOT_APPROVED));
    }
  });
  test("CATEGORY_BUSY (a provider-side code of POST /service-types/suggest) and any unknown 409 code degrade to the generic CONFLICT, never echoed", () => {
    assert.equal(errToFlash(409, "CATEGORY_BUSY"), "CONFLICT");
    assert.equal(errToFlash(409, "<script>"), "CONFLICT");
    assert.ok(F.CONFLICT);
  });
  test("a flash is rendered exactly once and with role=alert/status semantics (no raw backend message)", async () => {
    const r = await w.post("/admin/catalog", { ...cat("BROWS", "Брови", { name: "нігті" }), action: "save" });
    const h = (await w.get(r.location)).html;
    assert.equal((h.match(new RegExp(F.CATEGORY_NAME_EXISTS, "g")) ?? []).length, 1);
    assert.ok(!h.includes("CANARY-BACKEND-MESSAGE"));
  });
});

describe("route: hidden badge and unhide round trip", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const chipCount = (h) => (main(h).match(new RegExp(`>${uk.admin.catalog.hidden}<`, "g")) ?? []).length;

  test("seed: hidden categories carry the badge; a visible one does not", async () => {
    const h = (await w.get("/admin/catalog")).html;
    const block = (id) => main(h).split(/<details\b[^>]*class="[^"]*\bcat\b/).find((b) => b.includes(`name="id" value="${id}"`)) ?? "";
    assert.ok(block("MASAZH_NIH").includes(`>${uk.admin.catalog.hidden}<`));
    assert.ok(block("BEZ_ICONKY").includes(`>${uk.admin.catalog.hidden}<`));
    assert.ok(!block("BROWS").includes(`>${uk.admin.catalog.hidden}<`));
  });
  test("a hidden type inside an open category carries the badge too", async () => {
    const m = main((await w.get("/admin/catalog?open=BROWS")).html);
    assert.ok(m.includes("Архівний тип"));
    assert.ok(chipCount(`<main>${m}</main>`) >= 1);
  });
  test("show MASAZH_NIH: ONE PATCH {active:true} with the actor, the badge is gone, the offer flips to «Приховати»", async () => {
    const before = chipCount((await w.get("/admin/catalog")).html);
    const mark = (await w.calls()).length;
    const r = await w.post("/admin/catalog", { ...cat("MASAZH_NIH", "Масаж ніг (дубль)"), action: "show" });
    assert.equal(q(r.location).get("done"), "shown");
    assert.deepEqual((await w.calls()).slice(mark).map((c) => [c.method, c.path, c.body, c.actor]), [["PATCH", `${P}categories/MASAZH_NIH`, { active: true }, OWNER]]);
    const g = await w.get(r.location);
    assert.ok(main(g.html).includes(F.shown));
    const card = main(g.html).split(/<details\b[^>]*class="[^"]*\bcat\b/).find((b) => b.includes('name="id" value="MASAZH_NIH"'));
    assert.ok(!card.split("Масаж стоп")[0].includes(`>${uk.admin.catalog.hidden}<`), "the category lost its badge (its own hidden type keeps one)");
    assert.equal(chipCount(g.html), before, "one category badge gone, one hidden-type badge appeared (the card is open)");
    const form = [...main(g.html).matchAll(/<form\b[\s\S]*?<\/form>/g)].map((f) => f[0]).find((f) => f.includes('name="id" value="MASAZH_NIH"'));
    assert.ok(form.includes('value="hide"') && !form.includes('value="show"'));
  });
  test("hide it again, then show the icon-less one: the B541 banner and it stays hidden", async () => {
    const h = await w.post("/admin/catalog", { ...cat("MASAZH_NIH", "Масаж ніг (дубль)"), action: "hide" });
    assert.equal(q(h.location).get("done"), "hidden");
    const s = await w.post("/admin/catalog", { ...cat("BEZ_ICONKY", "Без іконки"), action: "show" });
    assert.equal(q(s.location).get("err"), "CATEGORY_ICON_REQUIRED");
    assert.ok(main((await w.get("/admin/catalog")).html).split("BEZ_ICONKY")[1].includes(uk.admin.catalog.hidden));
  });
});

describe("route: ?open= deep link", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const openDetails = (h) => (main(h).match(/<details\b[^>]*\bopen\b[^>]*class="[^"]*\bcat\b|<details\b[^>]*class="[^"]*\bcat\b[^"]*"[^>]*\bopen\b/g) ?? []).length;
  const gets = async (mark) => (await w.calls()).slice(mark).filter((c) => c.method === "GET").map((c) => c.path);

  test("a valid category opens only that card and costs exactly one extra GET (its types)", async () => {
    const mark = (await w.calls()).length;
    const g = await w.get("/admin/catalog?open=BROWS");
    assert.equal(openDetails(g.html), 1);
    assert.deepEqual(await gets(mark), [`${P}categories`, `${P}categories/BROWS/service-types`]);
    assert.ok(main(g.html).includes("Корекція брів") && !main(g.html).includes("Манікюр"));
  });
  test("an unknown but well-formed name opens nothing; a malformed one is ignored with no type call", async () => {
    for (const open of ["NOPE", "brows", "A/B", "%3Cscript%3E", "B".repeat(101), ""]) {
      const mark = (await w.calls()).length;
      const g = await w.get(`/admin/catalog?open=${open}`);
      assert.equal(g.status, 200, open);
      assert.equal(openDetails(g.html), 0, open);
      assert.ok(!/<script/i.test(g.html));
      assert.ok(!(await gets(mark)).some((p) => p.endsWith("/service-types")), `${open}: no type call`);
    }
  });
  test("the «Показати типи» link of a closed card is the same deep link", async () => {
    const m = main((await w.get("/admin/catalog")).html);
    const href = /href="(\/admin\/catalog\?open=NAILS)"/.exec(m)?.[1];
    assert.ok(href);
    assert.equal(openDetails((await w.get(href)).html), 1);
  });
  test("after a write the redirect carries ?open= of the card acted on (type writes) and the card renders open", async () => {
    const r = await w.post("/admin/catalog", { ...typ(NAILS_USED_TYPE, "NAILS", "Манікюр", { name: "Манікюр 2" }), action: "save" });
    assert.equal(q(r.location).get("open"), "NAILS");
    assert.equal(openDetails((await w.get(r.location)).html), 1);
  });
});

describe("route: pager bounds on a 200-category catalog (20 pages)", () => {
  let w;
  before(async () => { w = await startAdminHarness({ CATALOG_MOCK_CATEGORIES: "200" }); });
  after(() => w?.stop());
  const pager = (h) => /<nav[^>]*class="[^"]*pager[^"]*"[\s\S]*?<\/nav>/.exec(h)?.[0] ?? "";
  const links = (h) => [...pager(h).matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

  test("page 1: no «previous», next is ?p=2 and the label is 1 / 20", async () => {
    const h = (await w.get("/admin/catalog")).html;
    assert.deepEqual(links(h), ["/admin/catalog?p=2"]);
    assert.match(pager(h), /1 \/ 20/);
  });
  test("page 20: previous is ?p=19, no «next»", async () => {
    const h = (await w.get("/admin/catalog?p=20")).html;
    assert.deepEqual(links(h), ["/admin/catalog?p=19"]);
  });
  test("page 2: previous drops the query (page 1 has none)", async () => {
    assert.deepEqual(links((await w.get("/admin/catalog?p=2")).html), ["/admin/catalog", "/admin/catalog?p=3"]);
  });
  test("p=0, p=-1, p=1.5, p=abc: page 1 or the last page, never a 5xx and never an empty list", async () => {
    for (const p of ["0", "-1", "1.5", "abc", ""]) {
      const r = await w.get(`/admin/catalog?p=${p}`);
      assert.equal(r.status, 200, p);
      assert.match(pager(r.html), /1 \/ 20/, p);
    }
    const big = await w.get("/admin/catalog?p=1e3");
    assert.ok(big.status === 200 || (big.status === 303 && q(big.location).get("p") === "20"), `p=1e3 -> ${big.status}`);
  });
  test("p=21 and p=9999 (the 4-digit cap) redirect to page 20; 5+ digits are garbage = page 1", async () => {
    for (const p of ["21", "9999"]) {
      const r = await w.get(`/admin/catalog?p=${p}`);
      assert.equal(r.status, 303, p);
      assert.equal(q(r.location).get("p"), "20", p);
    }
    for (const p of ["10000", "99999999999"]) {
      const huge = await w.get(`/admin/catalog?p=${p}`);
      assert.equal(huge.status, 200, p);
      assert.match(pager(huge.html), /1 \/ 20/, p);
    }
  });
  test("the ?open= card survives paging links only where it lives (page 1 link has no open=)", async () => {
    const h = (await w.get("/admin/catalog?open=GEN_0001")).html;
    assert.ok(links(h).every((l) => !l.includes("open=")));
  });
});

describe("route: every backend call is made with the owner actor and the CATALOG key only", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());

  test("GET list + type list + each write kind (rename, hide, show, delete cat/type) carry X-Admin-Actor and the catalog key; none carries another key", async () => {
    const mark = (await w.calls()).length;
    await w.get("/admin/catalog?open=BROWS");
    await w.post("/admin/catalog", { ...cat("BROWS", "Брови", { name: "Брови 2" }), action: "save" });
    await w.post("/admin/catalog", { ...cat("BROWS", "Брови 2"), action: "hide" });
    await w.post("/admin/catalog", { ...cat("MASAZH_NIH", "x"), action: "show" });
    await w.post("/admin/catalog", { ...cat("STRAY", "Зайва"), action: "delete", confirm: "1" });
    await w.post("/admin/catalog", { ...typ(NAILS_FREE_TYPE, "NAILS", "x"), action: "delete", confirm: "1" });
    const calls = (await w.calls()).slice(mark);
    assert.deepEqual([...new Set(calls.map((c) => c.method))].sort(), ["DELETE", "GET", "PATCH"]);
    assert.ok(calls.length >= 7);
    for (const c of calls) {
      assert.equal(c.actor, OWNER, `${c.method} ${c.path}: X-Admin-Actor`);
      assert.equal(c.key, CATALOG_KEY, `${c.method} ${c.path}: X-Internal-Key is the catalog-scoped key`);
      assert.ok(c.path.startsWith(P), c.path);
    }
  });
  test("a write the Worker refuses itself (cross-site Origin) reaches the backend with nothing", async () => {
    const mark = (await w.calls()).length;
    const r = await fetch(`${w.base}/admin/catalog`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "x-test-origin": "https://evil.example" }, body: new URLSearchParams({ ...cat("BROWS", "Брови"), action: "hide" }) });
    assert.equal(r.status, 403);
    assert.deepEqual((await w.calls()).slice(mark), []);
  });
  test("source pin: the admin code never reads the master INTERNAL_API_KEY (comments aside)", () => {
    const files = [...readdirSync(`${ROOT}/src/lib/admin`).map((f) => `src/lib/admin/${f}`), "src/pages/admin/catalog.astro", "src/components/AdminCatalogRow.astro"];
    for (const f of files) {
      const code = readFileSync(`${ROOT}/${f}`, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      assert.ok(!/INTERNAL_API_KEY/.test(code), f);
    }
  });
});

describe("route: no client JS, CSP default-src 'none'", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());

  test("the page, a redirect and a flash page all carry the admin CSP (default-src 'none', no script-src, form-action 'self')", async () => {
    const post = await w.post("/admin/catalog", { ...cat("BROWS", "Брови"), action: "hide" });
    for (const r of [await w.get("/admin/catalog"), await w.get("/admin/catalog?open=BROWS"), await w.get(post.location), post]) {
      const csp = r.headers.get("content-security-policy");
      assert.equal(csp, ADMIN_CSP);
      assert.match(csp, /default-src 'none'/);
      assert.ok(!/script-src/.test(csp) && !/connect-src/.test(csp));
      assert.match(csp, /form-action 'self'/);
      assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    }
  });
  test("markup has no <script>, inline handler, javascript: URL, external origin, client directive or module preload", async () => {
    for (const path of ["/admin/catalog", "/admin/catalog?open=NAILS", "/admin/catalog?err=CATALOG_IN_USE&st=2&df=3"]) {
      const h = (await w.get(path)).html;
      assert.ok(!/<script/i.test(h), path);
      assert.ok(!/\son[a-z]+\s*=/i.test(h), `${path}: inline handler`);
      assert.ok(!/javascript:/i.test(h), path);
      assert.ok(!/modulepreload|astro-island|client:/i.test(h), path);
      assert.ok(!/(?:src|href|action)="https?:\/\//i.test(h), `${path}: external URL`);
    }
  });
  test("every form posts to the same path with method=post (works with scripts blocked)", async () => {
    const forms = [...main((await w.get("/admin/catalog?open=NAILS")).html).matchAll(/<form\b[^>]*>/g)].map((f) => f[0]);
    assert.ok(forms.length > 5);
    for (const f of forms) assert.match(f, /method="post"/i);
  });
});
