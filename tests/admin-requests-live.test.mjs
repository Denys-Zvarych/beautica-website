// W040 / W052 QA (live): /admin/requests end to end through the BUILT Worker (scripts/render-admin.mjs --serve: real middleware + Access JWT, local mock catalog backend).
// Complements tests/admin-requests.test.mjs (fake fetch + single-request renders): here several requests share one Worker, and every claim is checked against the
// mock backend's CALL LOG (method, path, exact JSON body, order), not only the HTML. Nothing leaves localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ADMIN_CSP } from "../src/lib/securityHeaders.ts";
import { FLASH_COOKIE, DONE_CODES, ERR_CODES, KEEP_MAX } from "../src/lib/admin/requests.ts";
import { ROOT, uk } from "./helpers/env.mjs";

const CANARY = "CANARY-BACKEND-MESSAGE"; // the mock's error `message`; it must never reach a page, a redirect or a cookie
const SVC1 = "5b0f3c1e-2d4a-4c1b-9a77-0a1b2c3d4e5f"; // seed: «Корекція брів воском»
const SVC2 = "9c1d2e3f-4a5b-4c6d-8e7f-001122334455"; // seed: «Нігті»
const gen = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`; // generated SERVICE_TYPE row i (i % 3 != 0); CATEGORY rows are ids 100 + i

/** Starts the harness on a free port with `rows` mock requests; resolves once the proxy prints its URL. */
async function startAdmin(rows) {
  const child = spawn(process.execPath, ["scripts/render-admin.mjs", "--serve", "0"], { cwd: ROOT, env: { ...process.env, CATALOG_MOCK_ROWS: String(rows) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  const base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`admin harness did not start in 280 s:\n${log}`)), 280_000);
    const on = (d) => { log += d; const m = /(http:\/\/127\.0\.0\.1:\d+)\/admin/.exec(log); if (m) { clearTimeout(t); resolve(m[1]); } };
    child.stdout.on("data", on); child.stderr.on("data", (d) => { log += d; });
    child.once("exit", (c) => reject(new Error(`admin harness exited (${c}):\n${log}`)));
  });
  const calls = async () => (await fetch(`${base}/__mock/calls`)).json();
  const writes = async (from = 0) => (await calls()).slice(from).filter((c) => c.method !== "GET");
  const get = async (path, headers = {}) => { const r = await fetch(base + path, { redirect: "manual", headers }); return { status: r.status, location: r.headers.get("location") ?? "", setCookie: r.headers.get("set-cookie") ?? "", headers: r.headers, html: await r.text() }; };
  const post = async (fields, headers = {}) => {
    const r = await fetch(`${base}/admin/requests`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
    return { status: r.status, location: r.headers.get("location") ?? "", setCookie: r.headers.get("set-cookie") ?? "", headers: r.headers, html: await r.text() };
  };
  const stop = () => { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } };
  return { base, calls, writes, get, post, stop };
}

const decode = (h) => h.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const main = (h) => h.match(/<body[\s\S]*<\/body>/)?.[0] ?? ""; // the page: shell + <main> + the dialog slot (outside <main>, W052 inert background)
const page = (h) => h.match(/<body[\s\S]*<\/body>/)?.[0] ?? ""; // sidebar + <main> + the flash toast (outside <main>)
const cards = (h) => (main(h).match(/<tr id="req-/g) ?? []).length; // W052: a request is a table row; its forms live in the detail / dialog panels
const flashOf = (h) => decode(/<div class="flash [^"]*" role="(status|alert)">[\s\S]*?<p>([^<]*)<\/p>/.exec(h)?.slice(1).join("|") ?? ""); // AdminFlash: toast / banner, role=status (done) or role=alert (error)
const q = (loc) => new URL(loc, "https://x.test").searchParams;
const card = (kind, id, origName, extra = {}) => ({ kind, id, origName, name: origName, ...extra });
const hidden = (h, name) => [...main(h).matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, "g"))].map((m) => m[1]);

describe("flow: list -> edit -> approve / reject, asserted on the backend call log", () => {
  let w;
  before(async () => { w = await startAdmin(8); });
  after(() => w?.stop());

  test("the list shows every pending request", async () => {
    const r = await w.get("/admin/requests");
    assert.equal(r.status, 200);
    assert.equal(cards(r.html), 8);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    assert.match(r.headers.get("x-robots-tag") ?? "", /noindex/);
  });

  test("edit name (save): exactly one PATCH {name}, no approve; the next GET shows the saved name and the «saved» banner", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post({ ...card("SERVICE_TYPE", SVC1, "Корекція брів воском"), name: "Корекція брів", action: "save" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/admin/requests?done=saved");
    const ws = await w.writes(mark);
    assert.deepEqual(ws.map((c) => [c.method, c.path, c.body, c.actor]), [["PATCH", `/api/v1/internal/catalog/requests/SERVICE_TYPE/${SVC1}`, { name: "Корекція брів" }, "owner@example.com"]]);
    const g = await w.get(r.location);
    assert.equal(flashOf(g.html), `status|${uk.admin.requests.flash.saved}`);
    assert.ok(decode(g.html).includes('>Корекція брів</a>'), "the list row shows the saved name");
  });

  test("approve with an edited name: PATCH {name} THEN POST /approve (no body), in that order; the row leaves the list", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post({ ...card("SERVICE_TYPE", SVC1, "Корекція брів"), name: "Корекція брів PRO", action: "approve" });
    assert.equal(r.location, "/admin/requests?done=approved");
    const ws = await w.writes(mark);
    assert.deepEqual(ws.map((c) => [c.method, c.path.split(SVC1)[1], c.body]), [["PATCH", "", { name: "Корекція брів PRO" }], ["POST", "/approve", null]]);
    const g = await w.get(r.location);
    assert.equal(flashOf(g.html), `status|${uk.admin.requests.flash.approved}`);
    assert.equal(cards(g.html), 7);
    assert.ok(!g.html.includes(SVC1));
  });

  test("a failed PATCH stops the chain: DUPLICATE_PENDING from the edit means no /approve call", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post({ ...card("SERVICE_TYPE", gen(5), "Заявка 5"), name: "dup", action: "approve" });
    assert.equal(q(r.location).get("err"), "DUPLICATE_PENDING");
    const ws = await w.writes(mark);
    assert.deepEqual(ws.map((c) => c.method), ["PATCH"], "no POST /approve after a failed edit");
  });

  test("reject with a reason: one POST /reject {reason: trimmed}; the «rejected» banner; the row leaves the list", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post({ ...card("SERVICE_TYPE", SVC2, "Нігті"), name: "ignored edit", action: "reject", reason: "  Дублікат категорії  " });
    assert.equal(r.location, "/admin/requests?done=rejected");
    const ws = await w.writes(mark);
    assert.deepEqual(ws.map((c) => [c.method, c.path.split(SVC2)[1], c.body]), [["POST", "/reject", { reason: "Дублікат категорії" }]]);
    const g = await w.get(r.location);
    assert.equal(flashOf(g.html), `status|${uk.admin.requests.flash.rejected}`);
    assert.ok(!g.html.includes(SVC2));
  });

  test("reject reason cap: 301 code points -> REASON_TOO_LONG and zero backend calls; exactly 300 (emoji = 1 each) reaches the backend intact", async () => {
    const mark = (await w.calls()).length;
    const bad = await w.post({ ...card("CATEGORY", "41", "Brow bar"), action: "reject", reason: "😀".repeat(301) });
    assert.equal(bad.location, "/admin/requests?err=REASON_TOO_LONG");
    assert.equal((await w.writes(mark)).length, 0);
    assert.equal(flashOf((await w.get(bad.location)).html), `alert|${uk.admin.requests.flash.REASON_TOO_LONG}`);
    const ok = await w.post({ ...card("CATEGORY", "41", "Brow bar"), action: "reject", reason: "😀".repeat(300) });
    assert.equal(ok.location, "/admin/requests?done=rejected");
    const ws = await w.writes(mark);
    assert.equal(ws.length, 1);
    assert.equal([...ws[0].body.reason].length, 300);
  });

  test("category edit sends initialServiceName only when it changed", async () => {
    const mark = (await w.calls()).length;
    await w.post({ ...card("CATEGORY", "103", "Категорія 3", { origInitialServiceName: "Послуга 3" }), initialServiceName: "Нова послуга", action: "save" });
    await w.post({ ...card("CATEGORY", "103", "Категорія 3", { origInitialServiceName: "Нова послуга" }), name: "Категорія 33", initialServiceName: "Нова послуга", action: "save" });
    assert.deepEqual((await w.writes(mark)).map((c) => c.body), [{ name: "Категорія 3", initialServiceName: "Нова послуга" }, { name: "Категорія 33" }]);
  });

  test("every flash banner renders its exact Ukrainian copy: done codes as role=status, error codes as role=alert", async () => {
    for (const c of DONE_CODES) assert.equal(flashOf((await w.get(`/admin/requests?done=${c}`)).html), `status|${uk.admin.requests.flash[c]}`, c);
    for (const c of ERR_CODES) assert.equal(flashOf((await w.get(`/admin/requests?err=${c}`)).html), `alert|${uk.admin.requests.flash[c]}`, c);
  });
});

describe("error mapping: backend data.code -> Ukrainian copy; the backend message never reaches the page", () => {
  let w;
  before(async () => { w = await startAdmin(8); });
  after(() => w?.stop());

  const cases = [
    ["DUPLICATE_PENDING", () => ({ ...card("SERVICE_TYPE", gen(4), "Заявка 4"), name: "dup", action: "save" })],
    ["TYPE_EXISTS", () => ({ ...card("SERVICE_TYPE", gen(4), "Заявка 4"), name: "exists", action: "save" })],
    ["CATEGORY_ICON_REQUIRED", () => ({ ...card("CATEGORY", "103", "Категорія 3"), name: "noicon", action: "approve" })], // edit ok, approve refused
  ];
  for (const [code, fields] of cases) {
    test(`${code}: redirect carries the code, the page shows its copy, the canary message appears nowhere`, async () => {
      const r = await w.post(fields());
      assert.equal(q(r.location).get("err"), code);
      assert.ok(!r.location.includes(CANARY) && !r.setCookie.includes(CANARY) && !r.html.includes(CANARY));
      const g = await w.get(r.location);
      assert.equal(flashOf(g.html), `alert|${uk.admin.requests.flash[code]}`);
      assert.ok(!g.html.includes(CANARY));
    });
  }

  test("REQUEST_NOT_PENDING: deciding the same request twice -> the second shows «already handled»", async () => {
    const first = await w.post({ ...card("CATEGORY", "106", "Категорія 6"), action: "approve" });
    assert.equal(first.location, "/admin/requests?done=approved");
    const second = await w.post({ ...card("CATEGORY", "106", "Категорія 6"), action: "reject" });
    assert.equal(q(second.location).get("err"), "REQUEST_NOT_PENDING");
    assert.ok(!second.location.includes(CANARY), "the backend message must not ride in the redirect");
    const g = await w.get(second.location);
    assert.equal(flashOf(g.html), `alert|${uk.admin.requests.flash.REQUEST_NOT_PENDING}`);
    assert.ok(!g.html.includes(CANARY));
  });

  test("untyped failures (400 bad characters, 404 unknown id) use the generic copy, never the backend message", async () => {
    const bad = await w.post({ ...card("SERVICE_TYPE", gen(4), "Заявка 4"), name: "x!", action: "save" });
    assert.equal(q(bad.location).get("err"), "BAD_INPUT");
    const gone = await w.post({ ...card("SERVICE_TYPE", gen(77), "x"), action: "approve" });
    assert.equal(q(gone.location).get("err"), "NOT_FOUND");
    for (const r of [bad, gone]) {
      assert.ok(!r.location.includes(CANARY) && !r.setCookie.includes(CANARY), "the backend message must not ride in the redirect");
      const g = await w.get(r.location);
      assert.ok(!g.html.includes(CANARY));
      assert.equal(flashOf(g.html).startsWith("alert|"), true);
    }
  });
});

describe("flash cookie: the typed name of a failed edit", () => {
  let w, set, cookie;
  before(async () => {
    w = await startAdmin(8);
    set = await w.post({ ...card("SERVICE_TYPE", gen(4), "Заявка 4"), name: "Бровки!!", action: "save" });
    cookie = set.setCookie.split(";")[0];
  });
  after(() => w?.stop());
  const target = `SERVICE_TYPE:${gen(4)}`;

  test(`${FLASH_COOKIE} attributes are exact: HttpOnly, Secure, SameSite=Strict, Path=/admin/requests, Max-Age=60, nothing else`, () => {
    const [nv, ...attrs] = set.setCookie.split("; ");
    assert.equal(nv.slice(0, nv.indexOf("=")), FLASH_COOKIE);
    assert.equal(decodeURIComponent(nv.slice(nv.indexOf("=") + 1)), "Бровки!!");
    assert.deepEqual(attrs.sort(), ["HttpOnly", "Max-Age=60", "Path=/admin/requests", "Secure", "SameSite=Strict"].sort());
  });

  test("the typed name is in no URL: Location carries code + card only", () => {
    assert.equal(set.status, 303);
    assert.equal(set.location, `/admin/requests?err=BAD_INPUT&card=${encodeURIComponent(target)}`);
    assert.ok(!decodeURIComponent(set.location).includes("Бровки"));
  });

  test("applied only to the one card ?card= names, and only with the cookie: not without ?card, not on the other cards, not without the cookie", async () => {
    const withCard = await w.get(set.location, { Cookie: cookie });
    assert.equal(hidden(withCard.html, "name").filter((v) => v === "Бровки!!").length, 1);
    assert.ok(/id="rn" name="name"[^>]*value="Бровки!!"/.test(withCard.html) && withCard.html.includes("Заявка 4"), "the detail of the named card opens with the typed name");
    assert.ok(withCard.html.includes('aria-invalid="true"'));
    const other = await w.get(`/admin/requests?err=BAD_INPUT&card=${encodeURIComponent(`SERVICE_TYPE:${gen(5)}`)}`, { Cookie: cookie });
    assert.ok(/id="rn" name="name"[^>]*value="Бровки!!"/.test(other.html) && other.html.includes("Заявка 5") && hidden(other.html, "name").length === 1, "follows ?card, never another request");
    for (const [path, headers] of [["/admin/requests?err=BAD_INPUT", { Cookie: cookie }], [set.location, {}]]) assert.ok(!(await w.get(path, headers)).html.includes("Бровки"), path);
  });

  test("read once: a GET that has the cookie answers with a deletion (Path=/admin/requests, expired); a GET without it sets nothing", async () => {
    const g = await w.get(set.location, { Cookie: cookie });
    assert.match(g.setCookie, new RegExp(`^${FLASH_COOKIE}=`));
    assert.match(g.setCookie, /Path=\/admin\/requests/);
    assert.match(g.setCookie, /Max-Age=0|Expires=Thu, 01 Jan 1970/);
    assert.equal((await w.get(set.location)).setCookie, "");
  });

  test("a hostile typed name is attribute-escaped on re-render; a long one is cut to the keep limit before it goes into the cookie", async () => {
    const evil = await w.post({ ...card("SERVICE_TYPE", gen(4), "Заявка 4"), name: `"><img src=x onerror=1>`, action: "save" });
    const g = await w.get(evil.location, { Cookie: evil.setCookie.split(";")[0] });
    assert.ok(g.html.includes('value="&quot;>'), "the typed double quote is escaped, so the value cannot close its attribute");
    assert.ok(!g.html.includes('"><img src=x'), "no element was injected after the attribute");
    const long = await w.post({ ...card("SERVICE_TYPE", gen(4), "Заявка 4"), name: "Б".repeat(KEEP_MAX + 50) + "!", action: "save" });
    const nv = long.setCookie.split(";")[0];
    assert.equal([...decodeURIComponent(nv.slice(nv.indexOf("=") + 1))].length, KEEP_MAX);
  });
});

describe("filters, search and the 200-request cap (W052 D2)", () => {
  let w;
  before(async () => { w = await startAdmin(51); });
  after(() => w?.stop());
  const reqGets = async (mark) => (await w.calls()).slice(mark).filter((c) => c.method === "GET" && c.path.includes("/requests?")).map((c) => c.path.replace(/^.*requests\?/, ""));
  const ids = (h) => [...main(h).matchAll(/<tr id="req-([^"]+)"/g)].map((m) => m[1]);
  const chip = (h, label) => Number(new RegExp(`${label}<span class="n">(\\d+)</span>`).exec(main(h))?.[1]);

  test("51 requests: the Worker loads all 3 backend pages, renders 25 per page (?p=); p=2 shows rows 26-50, p=3 the last one; stray p is clamped", async () => {
    const all = ids((await w.get("/admin/requests?p=1")).html);
    const loaded = ["status=PENDING&page=0&size=25", "status=PENDING&page=1&size=25", "status=PENDING&page=2&size=25"];
    for (const [p, from, to, n] of [["", 1, 25, 25], ["?p=2", 26, 50, 25], ["?p=3", 51, 51, 1], ["?p=abc", 1, 25, 25], ["?p=9999", 51, 51, 1]]) {
      const mark = (await w.calls()).length;
      const r = await w.get(`/admin/requests${p}`);
      assert.equal(r.status, 200, p);
      assert.equal(cards(r.html), n, p);
      assert.ok(r.html.includes(`Показано ${from}–${to} із 51`), p);
      assert.deepEqual((await reqGets(mark)).sort(), loaded, p);
      assert.ok(!r.html.includes(uk.admin.requests.capNotice));
    }
    assert.equal(cards((await w.get("/admin/requests")).html), 25);
    const p2 = ids((await w.get("/admin/requests?p=2")).html);
    assert.equal(p2.length, 25);
    assert.ok(p2.every((id) => !all.includes(id)), "page 2 is disjoint from page 1");
    assert.ok((await w.get("/admin/requests?p=2")).html.includes('aria-label="Сторінки заявок"'));
    assert.ok(!(await w.get("/admin/requests?kind=CATEGORY")).html.includes('aria-label="Сторінки заявок"'), "one page: no pager");
  });
  test("the filter applies BEFORE paging: the filtered set is paged, the pager keeps kind / q, a decision keeps p", async () => {
    const typ1 = ids((await w.get("/admin/requests?kind=SERVICE_TYPE")).html), typ2 = (await w.get("/admin/requests?kind=SERVICE_TYPE&p=2")).html;
    assert.equal(typ1.length, 25);
    assert.ok(ids(typ2).length > 0 && ids(typ2).every((id) => !/^\d+$/.test(id) && !typ1.includes(id)), "page 2 of the filtered set holds only more types");
    assert.ok(/href="\/admin\/requests\?kind=SERVICE_TYPE"/.test(typ2) && typ2.includes("Показано 26–"), "pager keeps kind, footer counts the filtered set");
    assert.match((await w.get(`/admin/requests?kind=SERVICE_TYPE&p=2&open=SERVICE_TYPE:${ids(typ2)[0]}`)).html, /name="p" value="2"/, "the detail form carries the page, so a decision comes back to it");
  });
  test("kind chips and counts: ?kind=CATEGORY / SERVICE_TYPE filter; the counts ignore q; an unknown kind is «Усі»", async () => {
    const all = (await w.get("/admin/requests")).html;
    const nCat = [...all.matchAll(/Категорії<span class="n">(\d+)/g)].map((m) => Number(m[1]))[0];
    assert.deepEqual(["Усі", "Категорії", "Типи послуг"].map((l) => chip(all, l)), [51, nCat, 51 - nCat]);
    const cat = (await w.get("/admin/requests?kind=CATEGORY")).html;
    assert.equal(cards(cat), Math.min(25, nCat)); assert.ok(ids(cat).every((id) => /^\d+$/.test(id)));
    const typ = (await w.get("/admin/requests?kind=SERVICE_TYPE")).html;
    assert.equal(cards(typ), Math.min(25, 51 - nCat)); assert.ok(ids(typ).every((id) => !/^\d+$/.test(id)));
    assert.equal(cards((await w.get("/admin/requests?kind=NOPE")).html), 25);
    const withQ = (await w.get("/admin/requests?kind=CATEGORY&q=Салон 3")).html;
    assert.equal(chip(withQ, "Усі"), 51, "chip counts ignore q");
  });
  test("q matches the label, the category and the requester (case-insensitive), is trimmed, and shows «Нічого не знайдено» + a reset link", async () => {
    assert.deepEqual(ids((await w.get("/admin/requests?q=%20категорія%2012%20")).html), ["112"], "the label (a category is listed by its display name), case-insensitive and trimmed");
    assert.ok(cards((await w.get("/admin/requests?q=BROWS")).html) > 0, "the category name of a type request");
    assert.deepEqual(ids((await w.get("/admin/requests?q=салон%2049")).html), [gen(49)], "the requester label");
    const none = (await w.get("/admin/requests?q=zzzzzz")).html;
    assert.equal(cards(none), 0);
    assert.ok(main(none).includes(uk.admin.requests.noneFound) && main(none).includes('href="/admin/requests"'));
    assert.ok(cards((await w.get(`/admin/requests?q=${"я".repeat(300)}`)).html) === 0, "an over-long q is cut to 100 code points, never a 5xx");
  });
  test("a decision keeps the list filter (kind, q) and the page field; page 1 / no filter adds nothing", async () => {
    const r = await w.post({ ...card("CATEGORY", "130", "x"), p: "2", fk: "CATEGORY", fq: "Салон", action: "approve" });
    assert.equal(r.location, "/admin/requests?done=approved&p=2&kind=CATEGORY&q=%D0%A1%D0%B0%D0%BB%D0%BE%D0%BD");
    const plain = await w.post({ ...card("CATEGORY", "133", "x"), fk: "ALL", fq: "  ", action: "approve" });
    assert.equal(plain.location, "/admin/requests?done=approved");
  });
});

describe("the 200-request cap", () => {
  let w;
  before(async () => { w = await startAdmin(250); });
  after(() => w?.stop());
  test("250 pending: 8 backend pages, 200 rows, the notice «Показано перші 200 заявок»", async () => {
    const mark = (await w.calls()).length;
    const r = await w.get("/admin/requests");
    const pages = (await w.calls()).slice(mark).filter((c) => c.path.includes("/requests?")).map((c) => /page=(\d+)/.exec(c.path)[1]);
    assert.equal(cards(r.html), 25);
    assert.ok(r.html.includes(uk.admin.requests.capNotice));
    assert.ok(r.html.includes("Показано 1–25 із 250"));
    assert.equal(cards((await w.get("/admin/requests?p=8")).html), 25, "200 rows = 8 pages of 25");
    assert.equal(cards((await w.get("/admin/requests?p=9")).html), 25, "p past the end clamps to the last page");
    assert.deepEqual(pages.sort(), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  });
});

describe("detail and dialogs by URL: ?open=KIND:id, ?dlg=approve|reject&id=KIND:id (W052 D1, D3)", () => {
  let w;
  before(async () => { w = await startAdmin(8); });
  after(() => w?.stop());
  const html = async (u) => (await w.get(u)).html;
  const NOT_PENDING = uk.admin.requests.flash.REQUEST_NOT_PENDING;

  test("the detail of a category: facts, editable name + first service, save / reject… / approve; the age pill; a sheet with a link scrim", async () => {
    const h = await html("/admin/requests?open=CATEGORY:41");
    assert.match(h, /<section class="dlg sheet"[^>]*role="dialog" aria-modal="true" aria-labelledby="dlg-t"/);
    assert.match(h, /<div class="app" inert[ >=]/, "the page behind the sheet is inert");
    assert.ok(h.indexOf("</main>") < h.indexOf('role="dialog"'), "the dialog is outside <main>/.app, so it is not inert itself");
    assert.ok(!/<div class="app" inert/.test((await html("/admin/requests")) ), "no dialog -> nothing inert");
    assert.ok(h.includes(uk.admin.requests.detailCat) && h.includes("Салон «Лотос»") && h.includes("Ламінування брів"));
    assert.match(h, /id="rn" name="name"[^>]*value="Brow bar"/);
    assert.match(h, /id="rs" name="initialServiceName"[^>]*value="Ламінування брів"/);
    assert.equal((h.match(/name="action" value="save"/g) ?? []).length, 1);
    assert.match(h, /href="\/admin\/requests\?dlg=reject&amp;id=CATEGORY%3A41&amp;open=CATEGORY%3A41"/);
    // «Схвалити» is a submit of the SAME form as the name fields (save-then-approve): edits are never dropped by a navigation to the confirm dialog.
    assert.ok(!/href="\/admin\/requests\?dlg=approve&amp;id=CATEGORY%3A41&amp;open=CATEGORY%3A41"/.test(h));
    assert.equal((h.match(/name="action" value="approve"/g) ?? []).length, 1);
    const form = h.slice(h.indexOf('<form method="post"'), h.indexOf("</form>", h.indexOf('<form method="post"')));
    assert.ok(form.includes('id="rn" name="name"') && form.includes('name="action" value="approve"'), "the approve button shares the form with the name field");
    assert.match(h, /class="scrim" href="\/admin\/requests"/);
    assert.match(h, /class="pill age bad"/, "a request older than 7 days is red");
  });
  test("the detail of a type has no first-service field and shows its category", async () => {
    const h = await html(`/admin/requests?open=SERVICE_TYPE:${SVC1}`);
    assert.ok(h.includes(uk.admin.requests.detailType) && h.includes("brows") && !h.includes('name="initialServiceName"'));
  });
  test("approve and reject panels: copy, hidden origName, one submit; reject has maxlength=300 and the static hint; cancel returns to the list (with the filter)", async () => {
    const a = await html("/admin/requests?kind=CATEGORY&dlg=approve&id=CATEGORY:41");
    assert.ok(a.includes(uk.admin.requests.approveTitle) && a.includes("«Brow bar» зʼявиться у каталозі як нова категорія") && a.includes(uk.admin.requests.approveConfirm));
    assert.match(a, /name="origName" value="Brow bar"/);
    assert.match(a, /name="fk" value="CATEGORY"/);
    assert.ok(a.includes('href="/admin/requests?kind=CATEGORY"'), "cancel / scrim keep the filter");
    const t = await html(`/admin/requests?dlg=approve&id=SERVICE_TYPE:${SVC2}`);
    assert.ok(t.includes("«Нігті» буде додано до категорії «nails»"));
    const r = await html("/admin/requests?dlg=reject&id=CATEGORY:41");
    assert.ok(r.includes(uk.admin.requests.rejectTitle) && r.includes(uk.admin.requests.rejectConfirm) && r.includes(uk.admin.requests.reasonHint) && r.includes(uk.admin.requests.reasonMax));
    assert.match(r, /<textarea[^>]*name="reason"[^>]*maxlength="300"/);
    assert.ok(!/<script/i.test(r));
  });
  test("an unknown, malformed or already-decided id: the list plus «Заявку вже розглянуто», no panel, no 5xx", async () => {
    for (const u of ["/admin/requests?open=CATEGORY:99999", "/admin/requests?open=garbage", "/admin/requests?dlg=approve&id=CATEGORY:99999", "/admin/requests?dlg=reject&id=%3Cb%3E", "/admin/requests?dlg=approve", `/admin/requests?dlg=approve&id=SERVICE_TYPE:${gen(9999)}`]) {
      const r = await w.get(u);
      assert.equal(r.status, 200, u);
      assert.ok(!/<section class="dlg/.test(r.html) && !/<script/i.test(r.html), u);
      assert.equal(flashOf(r.html), `alert|${NOT_PENDING}`, u);
    }
    assert.ok(!/<section class="dlg/.test((await w.get("/admin/requests?dlg=nuke&id=CATEGORY:41")).html), "an unknown dialog name opens nothing");
  });
  test("approve / reject from a panel: the same single POST as before (no PATCH for an unchanged name), then 303 + the flash; the row is gone", async () => {
    const mark = (await w.calls()).length;
    const a = await w.post({ kind: "CATEGORY", id: "41", origName: "Brow bar", origInitialServiceName: "Ламінування брів", name: "Brow bar", initialServiceName: "Ламінування брів", action: "approve" });
    assert.equal(a.location, "/admin/requests?done=approved");
    assert.deepEqual((await w.writes(mark)).map((c) => [c.method, c.path.split("/41")[1]]), [["POST", "/approve"]]);
    const g = await w.get(a.location);
    assert.equal(flashOf(g.html), `status|${uk.admin.requests.flash.approved}`);
    assert.match(g.html, /class="x" href="\/admin\/requests" aria-label="Закрити"/, "the toast's × drops done/err");
    assert.ok(!g.html.includes('id="req-41"'));
  });
  test("the waiting-age UI: red pills say only «Чекає N дн.» (no e-mail-link text, notification-only e-mails), and the «Заявки» count turns amber", async () => {
    const h = await html("/admin/requests");
    assert.ok(!h.includes(uk.admin.age.linkGone) && !h.includes("Посилання в листі"));
    assert.match(h, /class="pill age bad"/);
    assert.match(h, /<span class="count warn" aria-hidden="true">\d+<\/span>\s*<span class="sr">, \d+ [^<]*, є ті, що чекають понад 3 дні<\/span>/);
    assert.match(h, /aria-current="page"[^>]*title="Заявки на категорії й типи"/);
  });
});

describe("cross-site POST to /admin/requests (live)", () => {
  let w;
  before(async () => { w = await startAdmin(3); });
  after(() => w?.stop());

  test("a foreign Origin: 403, admin headers, and the backend is never called", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post({ ...card("CATEGORY", "41", "Brow bar"), action: "approve" }, { "x-test-origin": "https://evil.example" });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(r.headers.get("content-security-policy"), ADMIN_CSP);
    assert.equal((await w.calls()).length, mark, "no request reached the catalog backend");
  });

  test("the same form with the page's own Origin goes through (the 403 is the Origin check, not a blanket block)", async () => {
    const mark = (await w.calls()).length;
    const r = await w.post({ ...card("CATEGORY", "41", "Brow bar"), action: "reject" });
    assert.equal(r.status, 303);
    assert.equal((await w.writes(mark)).length, 1);
  });
});
