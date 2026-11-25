// W040 QA (live): /admin/requests end to end through the BUILT Worker (scripts/render-admin.mjs --serve: real middleware + Access JWT, local mock catalog backend).
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
    const t = setTimeout(() => reject(new Error(`admin harness did not start in 100 s:\n${log}`)), 100_000);
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
const main = (h) => h.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
const cards = (h) => (main(h).match(/<form\b[^>]*method="post"/g) ?? []).length;
const flashOf = (h) => decode(/<p class="[^"]*\bflash\b[^"]*"[^>]*role="(status|alert)"[^>]*>([^<]*)<\/p>/.exec(h)?.slice(1).join("|") ?? "");
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
    assert.ok(decode(g.html).includes('value="Корекція брів"'));
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
    assert.ok(withCard.html.includes(`id="n-${gen(4)}"`) && new RegExp(`id="n-${gen(4)}"[^>]*value="Бровки!!"`).test(withCard.html), "on the named card");
    assert.ok(withCard.html.includes('aria-invalid="true"'));
    const other = await w.get(`/admin/requests?err=BAD_INPUT&card=${encodeURIComponent(`SERVICE_TYPE:${gen(5)}`)}`, { Cookie: cookie });
    assert.ok(new RegExp(`id="n-${gen(5)}"[^>]*value="Бровки!!"`).test(other.html) && !new RegExp(`id="n-${gen(4)}"[^>]*value="Бровки!!"`).test(other.html), "follows ?card, never the others");
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

describe("pagination (51 pending requests = 3 pages of 25)", () => {
  let w;
  before(async () => { w = await startAdmin(51); });
  after(() => w?.stop());

  test("garbage ?p= (0, -1, abc, 2.5, empty, 5 digits) is page 1 and asks the backend for page index 0", async () => {
    for (const p of ["0", "-1", "abc", "2.5", "", "99999"]) {
      const mark = (await w.calls()).length;
      const r = await w.get(`/admin/requests?p=${p}`);
      assert.equal(r.status, 200, `p=${p}`);
      assert.equal(cards(r.html), 25, `p=${p}`);
      assert.ok(r.html.includes("Показано 1–25 із 51"), `p=${p}`);
      assert.match((await w.calls()).slice(mark)[0].path, /status=PENDING&page=0&size=25$/, `p=${p}`);
    }
  });

  test("past the end (p=4, p=9999) redirects to the last page, keeping the flash and card", async () => {
    for (const p of ["4", "9999"]) {
      const r = await w.get(`/admin/requests?p=${p}&done=approved&card=CATEGORY%3A41`);
      assert.equal(r.status, 303, p);
      const l = q(r.location);
      assert.equal(l.get("p"), "3");
      assert.equal(l.get("done"), "approved");
      assert.equal(l.get("card"), "CATEGORY:41");
      assert.ok(r.location.startsWith("/admin/requests?"), "relative");
    }
  });

  test("a middle and the last page: right window text, hidden p on every card, prev / next links", async () => {
    const mid = await w.get("/admin/requests?p=2");
    assert.ok(mid.html.includes("Показано 26–50 із 51"));
    assert.deepEqual([...new Set(hidden(mid.html, "p"))], ["2"]);
    assert.ok(mid.html.includes('href="/admin/requests"') && mid.html.includes('href="/admin/requests?p=3"'));
    const last = await w.get("/admin/requests?p=3");
    assert.equal(cards(last.html), 1);
    assert.ok(!last.html.includes(uk.admin.requests.next));
  });

  test("a decision on page 2 returns to page 2 (POST -> ?done=approved&p=2)", async () => {
    const r = await w.post({ ...card("CATEGORY", "130", "x"), p: "2", action: "approve" }); // 130 = generated category row i=30 (page 2)
    assert.equal(r.location, "/admin/requests?done=approved&p=2");
    assert.equal(cards((await w.get(r.location)).html), 25);
  });

  test("emptying the last page: deciding its only row on p=3 lands on p=2 (the new last page) with the banner", async () => {
    const r = await w.post({ ...card("SERVICE_TYPE", gen(50), "Заявка 50"), p: "3", action: "approve" });
    assert.equal(r.location, "/admin/requests?done=approved&p=3");
    const hop = await w.get(r.location);
    assert.equal(hop.status, 303);
    assert.deepEqual([...q(hop.location).entries()].sort(), [["done", "approved"], ["p", "2"]]);
    const landed = await w.get(hop.location);
    assert.equal(landed.status, 200);
    assert.ok(landed.html.includes("Показано 26–49 із 49"));
    assert.equal(flashOf(landed.html), `status|${uk.admin.requests.flash.approved}`);
    assert.ok(!landed.html.includes(uk.admin.requests.next), "p=2 is now the last page");
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
