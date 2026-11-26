// W041 / W052 QA, route level (complements tests/admin-catalog.test.mjs, which covers decide()/listCatalog() and the sample page): real form POSTs through the BUILT Worker
// (scripts/render-admin.mjs + scripts/lib/catalog-mock.mjs), judged on the mock backend's call log. Covers: the server-side typed-name delete confirm, every typed 409 banner,
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
const main = (h) => h.match(/<body[\s\S]*<\/body>/)?.[0] ?? ""; // W052: the page = sidebar + <main> (dialog panels) + the flash toast, which sits outside <main>
const cat = (id, name, extra = {}) => ({ kind: "category", id, origName: name, name, ...extra });
const typ = (id, c, name, extra = {}) => ({ kind: "type", id, cat: c, origName: name, name, origNameEn: "", nameEn: "", ...extra });
const NAILS_FREE_TYPE = "00020000-0000-4000-8000-000000000003"; // «Невикористаний тип», usage 0
const NAILS_USED_TYPE = "00020000-0000-4000-8000-000000000001";
const BROWS_ARCHIVED_TYPE = "00010000-0000-4000-8000-000000000003"; // inactive, usage 0

describe("route: delete needs the typed name on the server, not only in the UI (W052 D4, replaces confirm=1)", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const writesSince = async (mark) => (await w.calls()).slice(mark).filter((c) => c.method !== "GET");
  const cases = [
    ["category, no confirmName field", cat("STRAY", "Зайва"), {}],
    ["category, the old confirm=1 alone", cat("STRAY", "Зайва"), { confirm: "1" }],
    ["category, empty name", cat("STRAY", "Зайва"), { confirmName: "" }],
    ["category, another case", cat("STRAY", "Зайва"), { confirmName: "зайва" }],
    ["type, no confirmName field", typ(NAILS_FREE_TYPE, "NAILS", "Невикористаний тип"), {}],
    ["type, a wrong name", typ(NAILS_FREE_TYPE, "NAILS", "Невикористаний тип"), { confirmName: "Інший" }],
  ];
  for (const [label, base, extra] of cases) {
    test(`${label}: 303 to err=NAME_MISMATCH and ZERO backend calls`, async () => {
      const mark = (await w.calls()).length;
      const r = await w.post("/admin/catalog", { ...base, action: "delete", ...extra });
      assert.equal(r.status, 303);
      assert.equal(q(r.location).get("err"), "NAME_MISMATCH");
      assert.equal(q(r.location).get("done"), null);
      assert.deepEqual((await writesSince(mark)), [], "the backend must not be written to at all");
      const g = await w.get(r.location);
      assert.ok(main(g.html).includes(F.NAME_MISMATCH));
      assert.ok(g.html.includes('name="confirmName"'), "the confirm panel opens again");
    });
  }
  test("forged origName == confirmName != the real name (category and type): NAME_MISMATCH and ZERO writes", async () => {
    for (const base of [cat("STRAY", "Підроблена"), typ(NAILS_FREE_TYPE, "NAILS", "Підроблена")]) {
      const mark = (await w.calls()).length;
      const r = await w.post("/admin/catalog", { ...base, action: "delete", confirmName: "Підроблена" });
      assert.equal(r.status, 303);
      assert.equal(q(r.location).get("err"), "NAME_MISMATCH");
      assert.deepEqual((await writesSince(mark)), []);
    }
  });
  test("a forged delete of an unknown id is NOT_FOUND with zero writes", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post("/admin/catalog", { ...cat("NO_SUCH", "X"), action: "delete", confirmName: "X" });
    assert.equal(q(r.location).get("err"), "NOT_FOUND");
    assert.deepEqual((await writesSince(mark)), []);
  });
  test("after every refused attempt the rows still exist (nothing deleted)", async () => {
    const m = main((await w.get("/admin/catalog?open=NAILS")).html);
    assert.ok(m.includes('id="cat-STRAY"') && m.includes("Невикористаний тип"));
  });
  test("the exact typed name (trimmed): 303 to done=deleted and exactly ONE DELETE per row (category, then type)", async () => {
    let mark = (await w.calls()).length;
    const c = await w.post("/admin/catalog", { ...cat("STRAY", "Зайва"), action: "delete", confirmName: "  Зайва " });
    assert.equal(c.status, 303); assert.equal(q(c.location).get("done"), "deleted");
    assert.deepEqual((await writesSince(mark)).map((x) => [x.method, x.path, x.body]), [["DELETE", `${P}categories/STRAY`, null]]);
    mark = (await w.calls()).length;
    const t = await w.post("/admin/catalog", { ...typ(NAILS_FREE_TYPE, "NAILS", "Невикористаний тип"), action: "delete", confirmName: "Невикористаний тип" });
    assert.equal(q(t.location).get("done"), "deleted");
    assert.deepEqual((await writesSince(mark)).map((x) => [x.method, x.path]), [["DELETE", `${P}service-types/${NAILS_FREE_TYPE}`]]);
    assert.ok(!main((await w.get("/admin/catalog")).html).includes('id="cat-STRAY"'));
  });
});

describe("route: typed 409 banners, one per code", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const banner = async (loc, cookie) => main((await w.get(loc, cookie ? { cookie } : {})).html);

  test("CATALOG_IN_USE on a category with types but no usage: names the types only", async () => {
    const r = await w.post("/admin/catalog", { ...cat("MASAZH_NIH", "Масаж ніг (дубль)"), action: "delete", confirmName: "Масаж ніг (дубль)" });
    assert.equal(q(r.location).get("err"), "CATALOG_IN_USE");
    assert.equal(q(r.location).get("st"), "1");
    const text = await banner(r.location);
    assert.ok(text.includes("Використовується: 1 типів — вимкніть замість видалення."), text.replace(/\s+/g, " ").slice(0, 900));
    assert.ok(!/Використовується: \d+ послуг/.test(text), "no services count when there is no usage");
    assert.ok(text.includes(uk.admin.catalog.blockedTitle) && text.includes("<li>1 тип</li>"), "the blocked panel lists the type, no services line");
    assert.ok(!text.includes("Вибрано у"), "no services line when there is no usage");
  });
  test("CATALOG_IN_USE on a category with types AND usage: both counts, in the spec order", async () => {
    const r = await w.post("/admin/catalog", { ...cat("BROWS", "Брови"), action: "delete", confirmName: "Брови" });
    const text = await banner(r.location);
    assert.ok(text.includes("Використовується: 12 послуг, 3 типів — вимкніть замість видалення."));
    assert.ok(text.includes("<li>Вибрано у 12 послугах майстрів і салонів</li>") && text.includes("<li>3 типи</li>"));
  });
  test("CATEGORY_NAME_EXISTS: renaming a category onto another's name (case-insensitive) shows its banner and keeps the typed name in the field", async () => {
    const r = await w.post("/admin/catalog", { ...cat("BROWS", "Брови", { name: "нігті" }), action: "save" });
    assert.equal(q(r.location).get("err"), "CATEGORY_NAME_EXISTS");
    assert.ok(!decodeURIComponent(r.location).includes("нігті"), "the typed value is not in the URL");
    const cookie = r.setCookie.split(";")[0];
    const g = await w.get(r.location, { cookie });
    assert.ok(main(g.html).includes(F.CATEGORY_NAME_EXISTS));
    assert.ok(main(g.html).includes('value="нігті"'));
    assert.match(g.html, /<section class="dlg"[^>]*aria-modal="true"/, "the rename panel re-opens with the typed name");
    assert.ok(!/class="skip-link"/.test(g.html), "a modal page has no focusable skip link (the page behind is inert)");
    assert.match(g.html, /<div class="app" inert[ >=]/, "the page behind an open dialog is inert");
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

describe("route: disabled pill and enable round trip", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const PILL = `>${uk.admin.catalog.statusHidden}<`; // category status pill (a disabled type carries `typeHidden`, the same word)
  const pillCount = (h) => (main(h).match(new RegExp(PILL, "g")) ?? []).length;
  const block = (h, id) => main(h).split('<tr id="cat-').find((b) => b.startsWith(`${id}"`)) ?? "";

  test("seed: disabled categories carry the pill; an active one does not", async () => {
    const h = (await w.get("/admin/catalog")).html;
    assert.ok(block(h, "MASAZH_NIH").includes(PILL));
    assert.ok(block(h, "BEZ_ICONKY").includes(PILL));
    assert.ok(!block(h, "BROWS").includes(PILL));
  });
  test("a disabled type inside an open category carries the pill too", async () => {
    const m = main((await w.get("/admin/catalog?open=BROWS")).html);
    assert.ok(m.includes("Архівний тип"));
    assert.ok(pillCount((await w.get("/admin/catalog?open=BROWS")).html) >= 3, "two disabled categories + the archived type");
  });
  test("enable MASAZH_NIH: ONE PATCH {active:true} with the actor, its pill is gone, the row offers «Вимкнути»", async () => {
    const before = pillCount((await w.get("/admin/catalog")).html);
    const mark = (await w.calls()).length;
    const r = await w.post("/admin/catalog", { ...cat("MASAZH_NIH", "Масаж ніг (дубль)"), action: "show" });
    assert.equal(q(r.location).get("done"), "shown");
    assert.deepEqual((await w.calls()).slice(mark).map((c) => [c.method, c.path, c.body, c.actor]), [["PATCH", `${P}categories/MASAZH_NIH`, { active: true }, OWNER]]);
    const g = await w.get(r.location);
    assert.ok(main(g.html).includes(F.shown));
    const card = block(g.html, "MASAZH_NIH");
    assert.ok(!card.split("Масаж стоп")[0].includes(PILL), "the category lost its pill (its own disabled type keeps one)");
    assert.equal(pillCount(g.html), before, "one category pill gone, one disabled-type pill appeared (the card is open)");
    assert.ok(/dlg=disable(?:&amp;|&)cat=MASAZH_NIH"/.test(card) && !/dlg=enable(?:&amp;|&)cat=MASAZH_NIH"/.test(card), "the category row offers «Вимкнути»; only its own disabled type offers «Увімкнути»");
  });
  test("disable it again, then enable the icon-less one: the B541 banner and it stays disabled", async () => {
    const h = await w.post("/admin/catalog", { ...cat("MASAZH_NIH", "Масаж ніг (дубль)"), action: "hide" });
    assert.equal(q(h.location).get("done"), "hidden");
    const s = await w.post("/admin/catalog", { ...cat("BEZ_ICONKY", "Без іконки"), action: "show" });
    assert.equal(q(s.location).get("err"), "CATEGORY_ICON_REQUIRED");
    assert.ok(block((await w.get("/admin/catalog")).html, "BEZ_ICONKY").includes(PILL));
  });
});

describe("route: ?open= deep link", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const openDetails = (h) => (main(h).match(/class="exp on"/g) ?? []).length; // W052: an open category = its toggle link is `exp on` and its types row follows
  const gets = async (mark) => (await w.calls()).slice(mark).filter((c) => c.method === "GET" && !c.path.includes("/requests?")).map((c) => c.path); // the sidebar count (D5) is a separate, fixed GET

  test("a valid category opens only that card and costs exactly one extra GET (its types)", async () => {
    const mark = (await w.calls()).length;
    const g = await w.get("/admin/catalog?open=BROWS");
    assert.equal(openDetails(g.html), 1);
    assert.deepEqual(await gets(mark), [`${P}categories`, `${P}categories/BROWS/service-types`]);
    assert.equal((await w.calls()).slice(mark).filter((c) => c.path.includes("/requests?")).length, 1, "exactly one sidebar-count call");
    assert.ok(main(g.html).includes("Корекція брів") && !main(g.html).includes("Манікюр"));
  });
  test("a plain GET costs the catalog loads + exactly ONE pending call (page 1 only)", async () => {
    const mark = (await w.calls()).length;
    await w.get("/admin/catalog");
    const calls = (await w.calls()).slice(mark);
    const pending = calls.filter((c) => c.path.includes("/requests?"));
    assert.equal(pending.length, 1);
    assert.ok(pending[0].path.includes("page=0"));
    assert.equal(calls.length, 2, "categories + the one pending call");
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
  test("the type-toggle link of a closed card is the same deep link", async () => {
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
  const pager = (h) => /<nav[^>]*class="[^"]*\bpager\b[^"]*"[\s\S]*?<\/nav>/.exec(h)?.[0] ?? "";
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
    await w.post("/admin/catalog", { ...cat("STRAY", "Зайва"), action: "delete", confirmName: "Зайва" });
    await w.post("/admin/catalog", { ...typ(NAILS_FREE_TYPE, "NAILS", "x"), action: "delete", confirmName: "x" });
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
    const files = [...readdirSync(`${ROOT}/src/lib/admin`).map((f) => `src/lib/admin/${f}`), "src/pages/admin/catalog.astro", "src/pages/admin/requests.astro", "src/pages/admin/index.astro", "src/components/admin/AdminShell.astro"];
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
  test("every dialog form posts to its own path with method=post (works with scripts blocked); the only GET form is the search", async () => {
    for (const u of ["/admin/catalog?dlg=rename&cat=BROWS", "/admin/catalog?dlg=disable&cat=BROWS", "/admin/catalog?dlg=enable&cat=MASAZH_NIH", "/admin/catalog?dlg=delete&cat=STRAY"]) {
      const forms = [...main((await w.get(u)).html).matchAll(/<form\b[^>]*>/g)].map((f) => f[0]);
      assert.equal(forms.length, 2, u);
      assert.ok(forms.some((f) => /method="post"/i.test(f) && /action="\/admin\/catalog"/.test(f)), u);
      assert.ok(forms.every((f) => /method="post"/i.test(f) || /class="search" method="get" action="\/admin\/catalog"/.test(f)), u);
    }
  });
});
