// W052 QA (WEB-69, WEB-70): the acceptance items the per-page admin tests do not pin on the BUILT Worker (scripts/render-admin.mjs --serve: real middleware + Access JWT,
// local mock backend; nothing leaves localhost). Ages come from CATALOG_MOCK_AGES (whole Kyiv calendar days old, so no date in this file can rot), counts from
// CATALOG_MOCK_EXTRA_CATS. One behaviour per test; every claim is read off the rendered HTML.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_CSP } from "../src/lib/securityHeaders.ts";
import { startAdminHarness } from "./helpers/admin-harness.mjs";
import { uk } from "./helpers/env.mjs";

const body = (h) => h.match(/<body[\s\S]*<\/body>/)?.[0] ?? "";
const mainOf = (h) => h.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
const nav = (h) => h.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
/** [row id, pill class list, pill text] per request row, in page order (oldest first). */
const pills = (h) => [...mainOf(h).matchAll(/<tr id="req-([^"]+)"[\s\S]*?<span class="(pill age[^"]*)"[^>]*>[\s\S]*?(Чекає [^<]*)/g)].map((m) => [m[1], m[2], m[3].trim()]);
const sidebarCount = (h) => /<span class="(count[^"]*)" aria-hidden="true">(\d+)<\/span>\s*<span class="sr">([^<]*)<\/span>/.exec(nav(h))?.slice(1);

describe("waiting age: bands 0-2 neutral / 3-6 amber / 7+ red, plain text, amber sidebar count from 3 days (WEB-70)", () => {
  let all, young, edge;
  before(async () => {
    [all, young, edge] = await Promise.all([startAdminHarness({ CATALOG_MOCK_AGES: "0,2,3,6,7" }), startAdminHarness({ CATALOG_MOCK_AGES: "0,2" }), startAdminHarness({ CATALOG_MOCK_AGES: "0,3" })]);
  });
  after(() => { all?.stop(); young?.stop(); edge?.stop(); });

  test("each request row carries the pill of its band, oldest first: 7 red, 6 amber, 3 amber, 2 neutral, 0 neutral", async () => {
    const p = pills((await all.get("/admin/requests")).html);
    assert.deepEqual(p.map(([, cls, txt]) => [cls, txt]), [
      ["pill age bad", "Чекає 7 дн."], ["pill age warn", "Чекає 6 дн."], ["pill age warn", "Чекає 3 дн."], ["pill age", "Чекає 2 дн."], ["pill age", "Чекає від сьогодні"],
    ]);
  });
  test("the pill is plain «Чекає N дн.»: no e-mail-link text, no title tooltip, no hidden suffix, at any age", async () => {
    const m = mainOf((await all.get("/admin/requests")).html);
    assert.ok(!/Посилання|посилання/.test(m), "e-mail link wording");
    assert.ok(!/<span class="pill age[^>]*title=/.test(m), "tooltip on a pill");
    assert.ok(!/<span class="pill age[^>]*>[\s\S]{0,400}?<span class="sr">/.test(m), "hidden text inside a pill");
  });
  test("the request detail shows the same pill as its row (7 days: red)", async () => {
    const h = (await all.get("/admin/requests?open=CATEGORY:500")).html; // index 0 of "0,2,3,6,7" is the 0-day category
    assert.match(h, /class="pill age"[^>]*>[\s\S]*?Чекає від сьогодні/);
    const h7 = (await all.get("/admin/requests?open=CATEGORY:504")).html;
    assert.match(h7, /class="pill age bad"[^>]*>[\s\S]*?Чекає 7 дн\./);
  });
  test("the «Заявки» count is amber (with the spoken suffix) when any request waited 3+ days", async () => {
    const c = sidebarCount((await all.get("/admin/requests")).html);
    assert.deepEqual([c[0], c[1]], ["count warn", "5"]);
    assert.ok(c[2].endsWith(uk.admin.nav.urgentSuffix), c[2]);
  });
  test("the count stays neutral (no warn class, no suffix) while the oldest request is 2 days old", async () => {
    for (const path of ["/admin/requests", "/admin", "/admin/catalog"]) {
      const c = sidebarCount((await young.get(path)).html);
      assert.deepEqual([c[0], c[1]], ["count", "2"], path);
      assert.ok(!c[2].includes("понад 3 дні"), path);
    }
  });
  test("the boundary: a request of exactly 3 days turns the count amber on every admin page", async () => {
    for (const path of ["/admin/requests", "/admin", "/admin/catalog"]) assert.equal(sidebarCount((await edge.get(path)).html)[0], "count warn", path);
  });
  test("«Огляд» KPI: «з них N чекають понад 3 дні» counts 3+ days (3, 6, 7 = 3); absent while all are younger; no oldest-request card", async () => {
    const o = mainOf((await all.get("/admin")).html);
    assert.match(o, /kpi-old"[^>]*>[\s\S]*?з них 3 чекають понад 3 дні/);
    assert.ok(!/kpi-old/.test(mainOf((await young.get("/admin")).html)));
    assert.ok(!/oldest|найстаріш/i.test(o));
    const one = mainOf((await edge.get("/admin")).html); // exactly one 3-day request -> singular
    assert.match(one, /з них 1 чекає понад 3 дні/);
  });
});

describe("navigation as data and the «Огляд» structure", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());

  test("«Огляд» is a top-level item; «Категорії» is a labelled group with exactly «Заявки» then «Каталог»; no «Скарги» on any page", async () => {
    for (const [path, current] of [["/admin", "/admin"], ["/admin/requests", "/admin/requests"], ["/admin/catalog", "/admin/catalog"]]) {
      const h = (await w.get(path)).html;
      const secs = [...nav(h).matchAll(/<div class="nav-sec"([^>]*)>([\s\S]*?)<\/div>/g)];
      assert.equal(secs.length, 2, path);
      assert.ok(!/role="group"/.test(secs[0][1]), "«Огляд» is not inside a group");
      assert.deepEqual([...secs[0][2].matchAll(/<a class="nav-i" href="([^"]+)"/g)].map((m) => m[1]), ["/admin"]);
      assert.match(secs[1][1], /role="group" aria-labelledby="ns-categories"/);
      assert.match(secs[1][2], /id="ns-categories">Категорії<\/p>/);
      assert.deepEqual([...secs[1][2].matchAll(/<a class="nav-i" href="([^"]+)"/g)].map((m) => m[1]), ["/admin/requests", "/admin/catalog"]);
      assert.deepEqual([...nav(h).matchAll(/<a class="nav-i" href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]), [current], `${path}: exactly one current item`);
      assert.ok(!/Скарг/i.test(body(h)), `${path}: no «Скарги»`);
    }
  });
  test("«Огляд»: one «Категорії» heading, and the three KPI cards + the attention card sit under it, in order", async () => {
    const m = mainOf((await w.get("/admin")).html);
    assert.equal((m.match(/<h2/g) ?? []).length, 1, "a single section heading");
    const head = m.indexOf('id="ov-cat">Категорії</h2>');
    assert.ok(head > 0, "«Категорії» heading");
    const idx = [uk.admin.overview.kpiRequests, uk.admin.overview.kpiCats, "Вимкнено", "Каталог: на що глянути"].map((s) => m.indexOf(s));
    assert.ok(idx.every((i) => i > head) && idx.every((v, i) => i === 0 || v > idx[i - 1]), `order ${idx}`);
    assert.equal((m.match(/<a class="[^"]*\bkpi\b/g) ?? []).length, 3);
  });
});

describe("catalog wording: «Вимкнено / Вимкнути / Увімкнути» and the usage plural forms", () => {
  const USG = [[1, "у 1 послузі"], [2, "у 2 послугах"], [5, "у 5 послугах"], [11, "у 11 послугах"], [21, "у 21 послузі"], [22, "у 22 послугах"]];
  const extra = [
    ...USG.map(([n]) => ({ name: `USG${n}`, displayName: `Юзедж ${n}`, status: "APPROVED", active: true, usage: n })),
    ...Array.from({ length: 3 }, (_, i) => ({ name: `OFF${i}`, displayName: `Вимкн ${i}`, status: "APPROVED", active: false, usage: 0 })),
  ];
  let w;
  before(async () => { w = await startAdminHarness({ CATALOG_MOCK_EXTRA_CATS: JSON.stringify(extra) }); });
  after(() => w?.stop());

  test("usage cell: «у N послузі» for 1 / 21, «у N послугах» for 2, 5, 11, 22; always with «майстрів і салонів»", async () => {
    const m = mainOf((await w.get("/admin/catalog?q=юзедж")).html);
    for (const [n, text] of USG) {
      const row = new RegExp(`<tr id="cat-USG${n}"[\\s\\S]*?</tr>`).exec(m)?.[0] ?? "";
      assert.ok(row.includes(`<b>${text}</b>`), `${n} -> ${text}`);
      assert.ok(row.includes(`<small>${uk.admin.catalog.usageSub}</small>`), `${n} sub-label`);
    }
  });
  test("a category nobody picked says «Ніде не використано» (muted), not «у 0 послугах»", async () => {
    const row = /<tr id="cat-STRAY"[\s\S]*?<\/tr>/.exec(mainOf((await w.get("/admin/catalog")).html))?.[0] ?? "";
    assert.ok(row.includes(uk.admin.catalog.notUsed) && !/у 0 послуг/.test(row));
  });
  test("row actions are «Вимкнути» for an active category and «Увімкнути» for a disabled one, never the old words", async () => {
    const h = (await w.get("/admin/catalog?q=вимкн")).html;
    const row = (name) => new RegExp(`<tr id="cat-${name}"[\\s\\S]*?</tr>`).exec(mainOf(h))?.[0] ?? "";
    assert.ok(row("OFF0").includes("Увімкнути") && !row("OFF0").includes("Вимкнути"));
    assert.ok(row("OFF0").includes(uk.admin.catalog.statusHidden));
    const live = /<tr id="cat-USG1"[\s\S]*?<\/tr>/.exec(mainOf((await w.get("/admin/catalog?q=юзедж")).html))?.[0] ?? "";
    assert.ok(live.includes("Вимкнути") && !live.includes("Увімкнути"));
  });
  test("«Огляд» attention rows use the plural of the count: 5 disabled + 5 unused categories -> «5 категорій вимкнено» / «5 категорій ніде не використано»", async () => {
    // seed: 2 disabled (MASAZH_NIH, BEZ_ICONKY) + 3 extra = 5; unused = BEZ_ICONKY, STRAY + 3 extra = 5
    const m = mainOf((await w.get("/admin")).html);
    assert.ok(m.includes("5 категорій вимкнено"), "disabled plural");
    assert.ok(m.includes("5 категорій ніде не використано"), "unused plural");
  });
});

describe("dialogs are real modals on every page, and no admin variant loosens the CSP (WEB-69)", () => {
  let w;
  before(async () => { w = await startAdminHarness(); });
  after(() => w?.stop());
  const DIALOGS = [
    "/admin/requests?open=CATEGORY:41", "/admin/requests?dlg=approve&id=CATEGORY:41", "/admin/requests?dlg=reject&id=CATEGORY:41",
    "/admin/catalog?dlg=rename&cat=BROWS", "/admin/catalog?dlg=rename&cat=NAILS&type=00020000-0000-4000-8000-000000000001&open=NAILS",
    "/admin/catalog?dlg=disable&cat=BROWS", "/admin/catalog?dlg=enable&cat=MASAZH_NIH", "/admin/catalog?dlg=delete&cat=STRAY", "/admin/catalog?dlg=delete&cat=NAILS",
  ];
  const PLAIN = ["/admin", "/admin/requests", "/admin/catalog", "/admin/catalog?open=NAILS"];

  test("every dialog: role=dialog + aria-modal + a title, the app behind it `inert`, no skip link, ONE autofocus and it is inside the dialog, scrim is a link", async () => {
    for (const path of DIALOGS) {
      const h = (await w.get(path)).html;
      const at = h.indexOf('role="dialog"');
      assert.ok(at > 0, `${path}: dialog`);
      assert.match(h.slice(at - 40, at + 120), /role="dialog" aria-modal="true" aria-labelledby="dlg-t"/, path);
      assert.ok(h.includes('id="dlg-t"'), `${path}: title target`);
      assert.match(h, /<div class="app" inert[ >=]/, `${path}: inert background`);
      assert.ok(!/class="skip-link"/.test(h), `${path}: skip link`);
      const focus = [...h.matchAll(/\sautofocus[\s>=]/g)].map((m) => m.index);
      assert.equal(focus.length, 1, `${path}: exactly one autofocus`);
      assert.ok(focus[0] > at, `${path}: the autofocus is inside the dialog, not the inert page`);
      assert.match(h, /<a class="scrim" href="\/admin[^"]*" tabindex="-1" aria-hidden="true">/, `${path}: scrim link`);
    }
  });
  test("a plain page is the opposite: nothing inert, no aria-modal, no dialog, the skip link is the first focusable element", async () => {
    for (const path of PLAIN) {
      const h = (await w.get(path)).html;
      assert.ok(!/<div class="app" inert/.test(h) && !/aria-modal|role="dialog"|\sautofocus[\s>=]/.test(h), path);
      assert.match(body(h), /^<body><a class="skip-link" href="#main">/, `${path}: skip link first`);
    }
  });
  test("ADMIN_CSP is identical on every variant: lists, dialogs, flash, filters, paging, unknown targets, a redirect and the 404 catch-all; none has a script", async () => {
    const VARIANTS = [...PLAIN, ...DIALOGS, "/admin/requests?done=approved", "/admin/requests?err=BAD_INPUT", "/admin/catalog?done=deleted", "/admin/catalog?err=CATALOG_IN_USE&st=3&df=5",
      "/admin/requests?kind=SERVICE_TYPE&q=zz", "/admin/catalog?f=UNUSED", "/admin/catalog?f=NOPE&p=99999", "/admin/catalog?dlg=nuke&cat=BROWS", "/admin/requests?dlg=nuke&id=CATEGORY:41", "/admin/requests?open=garbage",
      "/admin/catalog?q=%22%20onfocus%3Dalert(1)%20x%3D%22", "/admin/nope", "/admin/"];
    for (const path of VARIANTS) {
      const r = await w.get(path);
      assert.ok([200, 303, 307, 404].includes(r.status), `${path}: ${r.status}`);
      assert.equal(r.headers.get("content-security-policy"), ADMIN_CSP, path);
      assert.match(r.headers.get("cache-control") ?? "", /no-store/, path);
      assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/, path);
      assert.ok(!/<script/i.test(r.html), `${path}: <script`);
    }
  });
  test("the same URLs, POSTed, also answer with exactly ADMIN_CSP (a decision's 303 and a refused one)", async () => {
    for (const [path, fields] of [["/admin/requests", { kind: "CATEGORY", id: "41", origName: "Brow bar", name: "Brow bar", action: "reject", reason: "x" }], ["/admin/catalog", { action: "hide", kind: "cat", cat: "BROWS", origName: "Брови" }]]) {
      const r = await w.post(path, fields);
      assert.equal(r.status, 303, path);
      assert.equal(r.headers.get("content-security-policy"), ADMIN_CSP, path);
    }
  });
});

describe("a non-owner gets 404 from every query form and every POST, with no body and no backend call (WEB-68, WEB-69)", () => {
  let anon;
  before(async () => { anon = await startAdminHarness({ RENDER_ADMIN_ANON: "1" }); });
  after(() => anon?.stop());

  test("filters, paging, dialogs, detail, flash codes, unknown targets and the catch-all: 404, nothing rendered", async () => {
    const URLS = ["/admin?x=1", "/admin/requests?kind=SERVICE_TYPE", "/admin/requests?q=x&p=2", "/admin/requests?done=approved", "/admin/requests?err=BAD_INPUT&card=CATEGORY:41", "/admin/requests?dlg=nuke&id=1",
      "/admin/catalog?f=UNUSED", "/admin/catalog?f=PENDING&q=x&p=3", "/admin/catalog?open=NAILS&dlg=delete&cat=NAILS", "/admin/catalog?dlg=rename&cat=NAILS&type=00020000-0000-4000-8000-000000000001&open=NAILS",
      "/admin/catalog?done=deleted", "/admin/catalog?err=CATALOG_IN_USE&st=1&df=2", "/admin/nope", "/admin/%72equests?dlg=approve&id=CATEGORY:41"];
    for (const path of URLS) {
      const r = await anon.get(path);
      assert.ok([404, 307].includes(r.status), `${path}: ${r.status}`);
      if (r.status === 404) assert.ok(!/<form|Заявки|Каталог|Огляд/.test(r.html), `${path}: page content leaked`);
    }
    assert.equal((await anon.get("/admin/requests?dlg=approve&id=CATEGORY:41")).status, 404);
  });
  test("every admin POST (decision, rename, disable, delete) is 404 and the backend sees nothing", async () => {
    for (const [path, f] of [["/admin/requests", { kind: "CATEGORY", id: "41", origName: "Brow bar", name: "Brow bar", action: "approve" }], ["/admin/requests", { kind: "CATEGORY", id: "41", origName: "Brow bar", action: "reject", reason: "x" }],
      ["/admin/catalog", { action: "hide", kind: "cat", cat: "BROWS", origName: "Брови" }], ["/admin/catalog", { action: "delete", kind: "cat", cat: "STRAY", origName: "Зайва", confirmName: "Зайва" }]]) {
      const r = await anon.post(path, f);
      assert.equal(r.status, 404, `${path} ${f.action}`);
    }
    assert.deepEqual(await anon.calls(), [], "no call reached the backend");
  });
});
