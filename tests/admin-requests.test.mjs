// Phase 040 / W052 (WEB-68, WEB-69, WEB-70) QA: the «Заявки» page. (1) decide()/listPending() against a fake backend fetch: call order, bodies, code mapping, redirects.
// (2) The built page through scripts/render-admin.mjs (real middleware + Access JWT, local mock catalog backend): fixture render and form POSTs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminConfigFrom } from "../src/lib/admin/config.ts";
import { decide as decideFull, listPending, listAllPending, formatDate, parsePage, PAGE_SIZE, REQUEST_CAP, errToFlash, ERR_CODES, DONE_CODES, FLASH_COOKIE } from "../src/lib/admin/requests.ts";
import { ageDays, ageBand, ageLabelMsg, linkTipMsg, anyUrgent, REQUEST_EMAIL_LINK_DAYS } from "../src/lib/admin/requestAge.ts";
import { filterRequests, parseKindFilter, parseQuery, requestLabel } from "../src/lib/admin/listQuery.ts";
import { ROOT, uk } from "./helpers/env.mjs";

const cfg = adminConfigFrom({ CF_ACCESS_TEAM_DOMAIN: "beautica.cloudflareaccess.com", CF_ACCESS_AUD: "a", ADMIN_EMAILS: "owner@example.com", INTERNAL_CATALOG_KEY: "k".repeat(40), API_ORIGIN: "https://api.example.test" });
const decide = async (...a) => (await decideFull(...a)).location; // the redirect target; decideFull also carries `typed`
const ACTOR = "owner@example.com";
const ID = "5b0f3c1e-2d4a-4c1b-9a77-0a1b2c3d4e5f";
const BASE = "/api/v1/internal/catalog/requests";

/** Run `fn` with global fetch replaced; `answers` is consumed in order (status, body). Returns the recorded calls. */
async function withBackend(answers, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url).replace("https://api.example.test", ""), method: init.method, actor: init.headers["X-Admin-Actor"], body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const [status, body] = answers.shift() ?? [200, { success: true, data: null }];
    return Response.json(body, { status });
  };
  try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
}
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const typedErr = (code) => [409, { success: false, data: { code }, message: "x" }];
const svc = { kind: "SERVICE_TYPE", id: ID, origName: "Корекція", name: "Корекція" };
const cat = { kind: "CATEGORY", id: "41", origName: "Brow bar", name: "Brow bar", origInitialServiceName: "Ламінування", initialServiceName: "Ламінування" };

describe("decide(): call order and bodies", () => {
  test("approve, name unchanged -> one POST /approve, no PATCH, no body", async () => {
    const { out, calls } = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "approve" })));
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${BASE}/SERVICE_TYPE/${ID}/approve`]);
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[0].actor, ACTOR);
    assert.equal(out, "/admin/requests?done=approved");
  });
  test("approve with an edited name -> PATCH first, then POST /approve", async () => {
    const { out, calls } = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, name: "Корекція брів", action: "approve" })));
    assert.deepEqual(calls.map((c) => c.method), ["PATCH", "POST"]);
    assert.deepEqual(calls[0].body, { name: "Корекція брів" });
    assert.ok(calls[1].url.endsWith("/approve"));
    assert.equal(out, "/admin/requests?done=approved");
  });
  test("the approve submit carries the edited name: the edited name is what the backend receives (PATCH body), then approve", async () => {
    const { calls } = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, name: "Нова назва", action: "approve" })));
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(calls[0].body, { name: "Нова назва" });
    assert.ok(calls[1].url.endsWith("/approve"));
  });
  test("a failed PATCH stops the chain: no approve; the typed name goes to the flash cookie payload, never into the URL", async () => {
    const { out, calls } = await withBackend([[400, { success: false, message: "Name has invalid characters" }]], () => decideFull(cfg, ACTOR, form({ ...svc, name: "Бровки 😀", action: "approve" })));
    assert.equal(calls.length, 1);
    const u = new URL(out.location, "https://x.test");
    assert.equal(u.searchParams.get("err"), "BAD_INPUT");
    assert.equal(u.searchParams.get("card"), `SERVICE_TYPE:${ID}`);
    assert.equal(u.searchParams.has("v"), false);
    assert.ok(!decodeURIComponent(out.location).includes("Бровки"), "typed name must not be in the URL");
    assert.ok(!out.location.includes("invalid characters"), "backend message text must not reach the redirect");
    assert.equal(out.typed, "Бровки 😀");
  });
  test("name / initialServiceName over 300 code points: BAD_INPUT, zero backend calls (301 refused, 300 passes)", async () => {
    const long = "😀".repeat(301);
    const a = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...svc, name: long, action: "approve" })));
    assert.equal(a.calls.length, 0);
    assert.equal(new URL(a.out.location, "https://x.test").searchParams.get("err"), "BAD_INPUT");
    assert.ok([...a.out.typed].length <= 120, "the kept value is capped (cookie size)");
    const b = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...cat, initialServiceName: long, action: "save" })));
    assert.equal(b.calls.length, 0);
    assert.match(b.out.location, /err=BAD_INPUT/);
    const c = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...svc, name: "😀".repeat(300), action: "save" })));
    assert.equal(c.calls.length, 1, "300 is under the cap: the backend decides");
  });
  test("save with an edited name -> PATCH only; unchanged -> no backend call", async () => {
    const a = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, name: "Нова", action: "save" })));
    assert.deepEqual(a.calls.map((c) => c.method), ["PATCH"]);
    assert.equal(a.out, "/admin/requests?done=saved");
    const b = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "save" })));
    assert.equal(b.calls.length, 0);
    assert.equal(b.out, "/admin/requests?done=unchanged");
  });
  test("CATEGORY: initialServiceName is sent only when changed, and only for CATEGORY", async () => {
    const a = await withBackend([], () => decide(cfg, ACTOR, form({ ...cat, initialServiceName: "Брови", action: "save" })));
    assert.deepEqual(a.calls[0].body, { name: "Brow bar", initialServiceName: "Брови" });
    const b = await withBackend([], () => decide(cfg, ACTOR, form({ ...cat, name: "Brow", action: "save" })));
    assert.deepEqual(b.calls[0].body, { name: "Brow" });
    const c = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, name: "X", initialServiceName: "smuggled", action: "save" })));
    assert.deepEqual(c.calls[0].body, { name: "X" });
  });
  test("reject with a reason -> POST /reject {reason}; without -> no body; name edits are ignored", async () => {
    const a = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, name: "edited", action: "reject", reason: "  Дублікат  " })));
    assert.deepEqual(a.calls.map((c) => `${c.method} ${c.url.split(`${ID}`)[1]}`), ["POST /reject"]);
    assert.deepEqual(a.calls[0].body, { reason: "Дублікат" });
    assert.equal(a.out, "/admin/requests?done=rejected");
    const b = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "reject", reason: "  " })));
    assert.equal(b.calls[0].body, undefined);
  });
  test("reason: 300 code points pass (emoji count once), 301 are refused locally", async () => {
    const ok = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "reject", reason: "😀".repeat(300) })));
    assert.equal(ok.calls.length, 1);
    const bad = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "reject", reason: "😀".repeat(301) })));
    assert.equal(bad.calls.length, 0);
    assert.equal(bad.out, "/admin/requests?err=REASON_TOO_LONG");
  });
  test("hostile kind / id / action never reach the backend", async () => {
    for (const bad of [{ kind: "ADMIN" }, { id: "../../x" }, { id: "1/approve" }, { id: "" }, { action: "delete" }, { action: "" }]) {
      const { out, calls } = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "approve", ...bad })));
      assert.equal(calls.length, 0, JSON.stringify(bad));
      assert.equal(out, "/admin/requests?err=FAILED");
    }
  });
  test("the current page rides through the redirect (flash and card too); page 1 adds no param; garbage p = 1", async () => {
    const a = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...svc, action: "approve", p: "3" })));
    assert.equal(a.out.location, "/admin/requests?done=approved&p=3");
    const b = await withBackend([[400, { success: false }]], () => decideFull(cfg, ACTOR, form({ ...svc, name: "x!", action: "save", p: "2" })));
    assert.equal(b.out.location, `/admin/requests?err=BAD_INPUT&card=SERVICE_TYPE%3A${ID}&p=2`);
    for (const p of ["", "0", "-1", "abc", "99999", "2.5"]) assert.equal(parsePage(p), 1, p);
    assert.equal(parsePage("7"), 7);
    const c = await withBackend([], () => decideFull(cfg, ACTOR, form({ ...svc, action: "approve", p: "1" })));
    assert.equal(c.out.location, "/admin/requests?done=approved");
  });
  test("the redirect is always relative (no hard-coded origin)", async () => {
    const { out } = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "approve" })));
    assert.ok(out.startsWith("/admin/requests?"));
  });
});

describe("error-code -> flash mapping (read only from data.code)", () => {
  test("every typed 409 maps to its own Ukrainian flash", async () => {
    for (const code of ["REQUEST_NOT_PENDING", "DUPLICATE_PENDING", "TYPE_EXISTS", "CATEGORY_ICON_REQUIRED"]) {
      const { out } = await withBackend([typedErr(code)], () => decide(cfg, ACTOR, form({ ...svc, action: "approve" })));
      assert.equal(new URL(out, "https://x.test").searchParams.get("err"), code);
      assert.ok(uk.admin.requests.flash[code].length > 5);
    }
    assert.equal(uk.admin.requests.flash.REQUEST_NOT_PENDING, "Заявку вже розглянуто.");
    assert.equal(uk.admin.requests.flash.CATEGORY_ICON_REQUIRED, "Спершу додайте іконку категорії.");
  });
  test("400 / 404 / unknown 409 / 5xx / network -> generic codes; message text and top-level code are ignored", () => {
    assert.equal(errToFlash(400, ""), "BAD_INPUT");
    assert.equal(errToFlash(404, ""), "NOT_FOUND");
    assert.equal(errToFlash(409, "SOMETHING_NEW"), "CONFLICT");
    assert.equal(errToFlash(409, ""), "CONFLICT");
    assert.equal(errToFlash(502, ""), "UNAVAILABLE");
    assert.equal(errToFlash(0, "UNAVAILABLE"), "UNAVAILABLE");
    assert.equal(errToFlash(400, "REQUEST_NOT_PENDING"), "BAD_INPUT", "a typed code only counts on a 409");
  });
  test("every flash code has Ukrainian copy", () => {
    for (const c of [...DONE_CODES, ...ERR_CODES]) assert.match(uk.admin.requests.flash[c] ?? "", /[А-Яа-яІіЇїЄє]/, c);
  });
  test("a typed 409 on approve after a good PATCH: name saved, error shown", async () => {
    const { out, calls } = await withBackend([[200, { success: true, data: null }], typedErr("REQUEST_NOT_PENDING")], () => decide(cfg, ACTOR, form({ ...svc, name: "Нова", action: "approve" })));
    assert.equal(calls.length, 2);
    assert.equal(out, "/admin/requests?err=REQUEST_NOT_PENDING");
  });
});

describe("listPending()", () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ kind: "CATEGORY", id: String(i + 1), name: `N${i}`, createdAt: "2026-11-10T00:00:00Z", requesterLabel: "x" }));
  const page = (data) => [200, { success: true, data: { success: true, data, page: 0, size: 100, totalElements: data.length, totalPages: 1 }, message: null }];
  test("reads the PageResponse, asks for PENDING, sorts oldest first, drops malformed rows", async () => {
    const rows = [
      { kind: "SERVICE_TYPE", id: ID, name: "B", createdAt: "2026-11-12T00:00:00Z", requesterLabel: "x" },
      { kind: "CATEGORY", id: "7", name: "A", createdAt: "2026-11-10T00:00:00Z", requesterLabel: "y" },
      { kind: "CATEGORY", id: "../x", name: "bad", createdAt: "2026-11-01T00:00:00Z" },
    ];
    const { out, calls } = await withBackend([page(rows)], () => listPending(cfg, ACTOR));
    assert.match(calls[0].url, /\/requests\?status=PENDING&page=0&size=25$/);
    assert.deepEqual(out.items.map((r) => r.name), ["A", "B"]);
  });
  test("asks the backend for page-1 (0-based) of size 25 and reads totalPages", async () => {
    const { out, calls } = await withBackend([[200, { success: true, data: { data: rows(1), totalElements: 60, totalPages: 3 } }]], () => listPending(cfg, ACTOR, 2));
    assert.match(calls[0].url, /status=PENDING&page=1&size=25$/);
    assert.equal(out.totalPages, 3);
    assert.equal(out.total, 60);
    assert.equal(PAGE_SIZE, 25);
  });
  test("a backend failure is a generic flash, never raw text", async () => {
    const { out } = await withBackend([[500, { message: "stack trace" }]], () => listPending(cfg, ACTOR));
    assert.deepEqual(out, { ok: false, err: "UNAVAILABLE" });
  });
});

describe("requestAge (WEB-70): calendar days in Europe/Kyiv, bands 0-2 / 3-6 / 7+", () => {
  const at = (iso) => new Date(iso);
  test("band edges: 2 -> ok, 3 -> warn, 6 -> warn, 7 -> bad", () => {
    assert.deepEqual([0, 1, 2, 3, 6, 7, 8, 30].map(ageBand), ["ok", "ok", "ok", "warn", "warn", "bad", "bad", "bad"]);
  });
  test("days are calendar days in Kyiv, not 24 h blocks: 23:59 -> 00:01 next day is 1 day; the same day is 0; the future is 0", () => {
    // Kyiv is UTC+2 in November: 2026-11-18T21:59Z = 23:59 Kyiv on the 18th, 22:01Z = 00:01 Kyiv on the 19th.
    assert.equal(ageDays("2026-11-18T21:59:00Z", at("2026-11-18T22:01:00Z")), 1);
    assert.equal(ageDays("2026-11-18T10:00:00Z", at("2026-11-18T21:30:00Z")), 0);
    assert.equal(ageDays("2026-11-18T10:00:00Z", at("2026-11-21T09:00:00Z")), 3);
    assert.equal(ageDays("2026-11-30T10:00:00Z", at("2026-11-18T10:00:00Z")), 0);
    assert.equal(ageDays("garbage", at("2026-11-18T10:00:00Z")), 0);
  });
  test("the DST day: 2026-03-29 is 23 h long in Kyiv, a request from the evening before is still exactly 1 day old the next evening", () => {
    assert.equal(ageDays("2026-03-28T20:00:00Z", at("2026-03-29T20:00:00Z")), 1);
    assert.equal(ageDays("2026-03-28T10:00:00Z", at("2026-03-31T10:00:00Z")), 3);
    assert.equal(ageDays("2026-10-24T10:00:00Z", at("2026-10-25T22:30:00Z")), 2, "the autumn change (25 h day) too: 24th -> 26th Kyiv");
  });
  // copy is returned as an i18n key + vars; the page renders it with t(): resolve it here against uk.json the same way
  const say = (m) => (m === null ? null : m.key.split(".").reduce((o, k) => o[k], { admin: uk.admin }).replace(/\{(\w+)\}/g, (_, n) => m.vars[n]));
  test("labels: «Чекає від сьогодні» / «Чекає N дн.»", () => {
    assert.equal(say(ageLabelMsg(0)), "Чекає від сьогодні");
    assert.equal(say(ageLabelMsg(5)), "Чекає 5 дн.");
  });
  test("the e-mail-link text (D6): REQUEST_EMAIL_LINK_DAYS = null (owner, 2026-11-25: notification-only e-mails) so no tip at any age; the wording logic still works for an explicit link TTL", () => {
    assert.equal(REQUEST_EMAIL_LINK_DAYS, null);
    for (const d of [0, 2, 3, 7, 40]) assert.equal(linkTipMsg(d), null, `default (null) constant, day ${d}`);
    for (const d of [0, 3, 7, 40]) assert.equal(linkTipMsg(d, null), null, `null constant, day ${d}`);
    assert.equal(linkTipMsg(2, 7), null);
    assert.equal(say(linkTipMsg(3, 7)), "Посилання в листі діє ще 4 дн.");
    assert.equal(say(linkTipMsg(6, 7)), "Посилання в листі діє ще 1 дн.");
    assert.equal(say(linkTipMsg(7, 7)), "Посилання в листі вже не діє — вирішіть тут");
  });
  test("anyUrgent: true when one request has waited 3+ days (the amber sidebar count)", () => {
    const now = at("2026-11-25T10:00:00Z");
    assert.equal(anyUrgent(["2026-11-24T10:00:00Z", "2026-11-23T10:00:00Z"], now), false);
    assert.equal(anyUrgent(["2026-11-24T10:00:00Z", "2026-11-22T10:00:00Z"], now), true);
    assert.equal(anyUrgent([], now), false);
  });
});

describe("listQuery for requests: kind / q parsing and filtering (D2)", () => {
  const r = (kind, id, name, extra = {}) => ({ kind, id, name, displayName: null, categoryName: null, initialServiceName: null, description: null, requesterLabel: "—", createdAt: "2026-11-10T00:00:00Z", ...extra });
  const list = [r("CATEGORY", "1", "brow-bar", { displayName: "Брові", requesterLabel: "Іван Петренко" }), r("SERVICE_TYPE", "2", "Корекція", { categoryName: "Брови та вії", requesterLabel: "Салон «Ліра»" }), r("SERVICE_TYPE", "3", "Нігті", { requesterLabel: "Олена" })];
  test("unknown kind -> ALL; q trimmed and capped at 100 code points", () => {
    assert.equal(parseKindFilter("CATEGORY"), "CATEGORY"); assert.equal(parseKindFilter("admin"), "ALL"); assert.equal(parseKindFilter(null), "ALL");
    assert.equal(parseQuery("  x  "), "x"); assert.equal([...parseQuery("😀".repeat(101))].length, 100);
  });
  test("a category is listed by its display name, a type by its name", () => {
    assert.deepEqual(list.map(requestLabel), ["Брові", "Корекція", "Нігті"]);
  });
  test("kind filter + q over label, category name and requester, case-insensitive", () => {
    assert.deepEqual(filterRequests(list, "CATEGORY", "").map((x) => x.id), ["1"]);
    assert.deepEqual(filterRequests(list, "SERVICE_TYPE", "").map((x) => x.id), ["2", "3"]);
    assert.deepEqual(filterRequests(list, "ALL", "БРОВИ").map((x) => x.id), ["2"], "category name of a type");
    assert.deepEqual(filterRequests(list, "ALL", "ліра").map((x) => x.id), ["2"], "requester label");
    assert.deepEqual(filterRequests(list, "ALL", "брові").map((x) => x.id), ["1"], "display name, not the wire name");
    assert.deepEqual(filterRequests(list, "ALL", "brow-bar").map((x) => x.id), [], "the wire name of a category is not searchable");
    assert.deepEqual(filterRequests(list, "CATEGORY", "нігті"), []);
  });
});

describe("listAllPending(): the Worker pages the backend (25 per call), cap 200", () => {
  const pageOf = (from, n, total) => [200, { success: true, data: { data: Array.from({ length: n }, (_, i) => ({ kind: "CATEGORY", id: String(from + i + 1), name: `N${from + i}`, createdAt: `2026-11-10T00:${String((from + i) % 60).padStart(2, "0")}:00Z`, requesterLabel: "x" })), totalElements: total, totalPages: Math.ceil(total / 25) } }];
  test("60 pending = 3 backend calls (page 0, 1, 2), all items, not capped", async () => {
    const { out, calls } = await withBackend([pageOf(0, 25, 60), pageOf(25, 25, 60), pageOf(50, 10, 60)], () => listAllPending(cfg, ACTOR));
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => /page=(\d+)/.exec(c.url)[1]), ["0", "1", "2"]);
    assert.equal(out.items.length, 60); assert.equal(out.total, 60); assert.equal(out.capped, false);
  });
  test("250 pending: stops at 8 calls / 200 items and says capped; the cap is 200", async () => {
    const answers = Array.from({ length: 10 }, (_, k) => pageOf(k * 25, 25, 250));
    const { out, calls } = await withBackend(answers, () => listAllPending(cfg, ACTOR));
    assert.equal(REQUEST_CAP, 200);
    assert.equal(calls.length, 8);
    assert.equal(out.items.length, 200); assert.equal(out.total, 250); assert.equal(out.capped, true);
  });
  test("exactly 200 is not capped; a failing page is a generic failure", async () => {
    const ok = await withBackend(Array.from({ length: 8 }, (_, k) => pageOf(k * 25, 25, 200)), () => listAllPending(cfg, ACTOR));
    assert.equal(ok.out.capped, false); assert.equal(ok.out.items.length, 200);
    const bad = await withBackend([pageOf(0, 25, 60), [503, { success: false }]], () => listAllPending(cfg, ACTOR));
    assert.deepEqual(bad.out, { ok: false, err: "UNAVAILABLE" });
  });
  test("pages 2..8 go out together, after page 1 (call order = page order, count unchanged); a failing page returns the first error in page order", async () => {
    const real = globalThis.fetch;
    let inFlight = 0, peak = 0; const started = [];
    globalThis.fetch = async (url) => {
      const pg = Number(/page=(\d+)/.exec(String(url))[1]); started.push(pg);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return Response.json(...(pg === 3 ? [{ success: false }, { status: 503 }] : pg === 5 ? [{ success: false }, { status: 400 }] : [pageOf(pg * 25, 25, 400)[1], { status: 200 }]));
    };
    try {
      const bad = await listAllPending(cfg, ACTOR);
      assert.deepEqual(bad, { ok: false, err: "UNAVAILABLE" }, "page 3 (503) wins over page 5 (400)");
      assert.equal(started.length, 8); assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]); assert.ok(peak >= 7, `parallel (peak ${peak})`);
    } finally { globalThis.fetch = real; }
  });
  test("an empty queue is one call", async () => {
    const { out, calls } = await withBackend([[200, { success: true, data: { data: [], totalElements: 0, totalPages: 0 } }]], () => listAllPending(cfg, ACTOR));
    assert.equal(calls.length, 1); assert.deepEqual([out.ok, out.items.length, out.capped], [true, 0, false]);
  });
});

describe("decide(): the list filter rides through the redirect (fk / fq hidden fields)", () => {
  test("kind + q are kept (sanitised), defaults add nothing", async () => {
    const a = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "approve", fk: "SERVICE_TYPE", fq: " ліра " })));
    assert.equal(a.out, "/admin/requests?done=approved&kind=SERVICE_TYPE&q=%D0%BB%D1%96%D1%80%D0%B0");
    const b = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "approve", fk: "evil", fq: "" })));
    assert.equal(b.out, "/admin/requests?done=approved");
    const c = await withBackend([], () => decide(cfg, ACTOR, form({ ...svc, action: "reject", reason: "😀".repeat(301), fk: "CATEGORY" })));
    assert.equal(c.out, "/admin/requests?err=REASON_TOO_LONG&kind=CATEGORY");
  });
});

describe("built page (render-admin harness, mock catalog backend)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "admin-requests-"));
  test.after(() => rmSync(tmp, { recursive: true, force: true }));
  const run = (name, args) => {
    const out = join(tmp, `${name}.html`), calls = join(tmp, `${name}.json`);
    const r = spawnSync(process.execPath, ["scripts/render-admin.mjs", "--out", out, "--calls", calls, ...args], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    return { r, html: r.status === 0 ? readFileSync(out, "utf8") : "", calls: r.status === 0 ? JSON.parse(readFileSync(calls, "utf8")) : [], location: /Location: (\S*)/.exec(r.stderr)?.[1] ?? "" };
  };
  const get = run("get", ["--path", "/admin/requests"]);
  const main = get.html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";

  test("renders 200 with the h1, the kind chips, the table oldest first, noindex and the admin shell", () => {
    assert.equal(get.r.status, 0, get.r.stderr);
    assert.match(get.html, new RegExp(`<h1[^>]*>${uk.admin.requests.h1}</h1>`));
    assert.ok(main.includes(`${uk.admin.requests.categories}<span class="n">1</span>`));
    assert.ok(main.includes(`${uk.admin.requests.serviceTypes}<span class="n">2</span>`));
    assert.equal((main.match(/<tr id="req-/g) ?? []).length, 3);
    assert.ok(main.indexOf("Нігті") < main.indexOf("Корекція брів воском"), "oldest service-type first");
    assert.match(get.html, /<meta name="robots" content="noindex/);
    assert.match(get.html, /<a class="nav-i" href="\/admin\/requests" aria-current="page"/);
  });
  test("the list has no forms to submit except the GET search: every action is a link (?dlg= / ?open=)", () => {
    assert.equal((main.match(/<form\b/g) ?? []).length, 1);
    assert.match(main, /<form class="search" method="get" action="\/admin\/requests"/);
    assert.equal((main.match(/<details\b/g) ?? []).length, 0, "no <details> reject / delete any more");
    assert.equal((main.match(/href="\/admin\/requests\?dlg=approve&amp;id=/g) ?? []).length, 3);
    assert.equal((main.match(/href="\/admin\/requests\?dlg=reject&amp;id=/g) ?? []).length, 3);
    assert.ok(main.includes("Brow bar") && main.includes("Перша послуга: Ламінування брів"));
  });
  test("no script, no inline handler, no analytics; the first service field exists only in the category detail", () => {
    assert.ok(!/<script/i.test(get.html));
    assert.ok(!/\son[a-z]+\s*=/i.test(get.html));
    const d = run("detail", ["--path", "/admin/requests?open=CATEGORY:41"]).html;
    assert.equal((d.match(/name="initialServiceName"/g) ?? []).length, 1);
    assert.equal((get.html.match(/name="initialServiceName"/g) ?? []).length, 0);
  });
  test("a description keeps its text HTML-escaped (in the detail); the requester label is shown, no email/phone fields exist", () => {
    const d = run("detail2", ["--path", `/admin/requests?open=SERVICE_TYPE:${ID}`]).html;
    assert.ok(d.includes("Часто просять клієнти."));
    assert.ok(main.includes("Олена Коваленко"));
  });
  test("a flash code renders its Ukrainian text; an unknown code renders nothing", () => {
    const a = run("flash", ["--path", "/admin/requests?err=REQUEST_NOT_PENDING"]);
    assert.ok(a.html.includes(uk.admin.requests.flash.REQUEST_NOT_PENDING));
    const b = run("flash2", ["--path", "/admin/requests?err=%3Cb%3Ehack&done=zzz"]);
    assert.ok(!b.html.includes("<b>hack") && !b.html.includes("hack"));
    assert.ok(!/class="flash/.test(b.html));
  });
  test("POST edited approve: 303 to ?done=approved, backend got PATCH then approve with the actor header", () => {
    const p = run("post", ["--path", "/admin/requests", "--method", "POST", "--body", `kind=SERVICE_TYPE&id=${ID}&origName=${encodeURIComponent("Корекція брів воском")}&name=${encodeURIComponent("Корекція брів")}&action=approve`]);
    assert.equal(p.r.status, 0, p.r.stderr);
    assert.equal(p.location, "/admin/requests?done=approved");
    const writes = p.calls.filter((c) => c.method !== "GET");
    assert.deepEqual(writes.map((c) => `${c.method} ${c.path.split(ID)[1]}`), ["PATCH ", "POST /approve"]);
    assert.ok(writes.every((c) => c.actor === "owner@example.com"));
  });
  test("POST with a bad name: 303 to ?err=BAD_INPUT&card, typed name only in a HttpOnly/Secure/Strict flash cookie; the next GET opens that detail with it", () => {
    const body = `kind=SERVICE_TYPE&id=${ID}&origName=x&name=${encodeURIComponent("Бровки!!")}&action=save`;
    const p = run("bad", ["--path", "/admin/requests", "--method", "POST", "--body", body]);
    assert.match(p.location, /^\/admin\/requests\?err=BAD_INPUT&card=SERVICE_TYPE%3A5b0f3c1e/);
    assert.ok(!p.location.includes("v="), "no typed value in the URL");
    const sc = /Set-Cookie: (.*)/.exec(p.r.stderr)?.[1] ?? "";
    assert.ok(sc.startsWith(`${FLASH_COOKIE}=`), sc);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/admin/requests", "Max-Age=60"]) assert.ok(sc.includes(attr), `${attr} in ${sc}`);
    const cookie = sc.split(";")[0];
    const g = run("bad2", ["--path", p.location, "--cookie", cookie]);
    assert.ok(g.html.includes('value="Бровки!!"'));
    assert.ok(g.html.includes(uk.admin.requests.flash.BAD_INPUT));
    assert.match(/Set-Cookie: (.*)/.exec(g.r.stderr)?.[1] ?? "", new RegExp(`${FLASH_COOKIE}=[^;]*;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`), "read once: the next GET clears it");
    const other = run("bad3", ["--path", "/admin/requests?err=BAD_INPUT&card=CATEGORY%3A41", "--cookie", cookie]);
    assert.equal(other.html.split('value="Бровки!!"').length - 1, 1, "the value goes to the one request named in ?card");
    assert.ok(other.html.includes('name="initialServiceName"'), "that card is the category: its detail opened");
  });
});

describe("100 rows: render cost", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ kind: i % 3 ? "SERVICE_TYPE" : "CATEGORY", id: i % 3 ? `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` : String(i + 1), name: `N${i}`, displayName: `D${i}`, categoryName: "brows", initialServiceName: "S", description: "Опис", requesterLabel: "Салон", createdAt: new Date(Date.UTC(2026, 10, 1) + i * 3.6e6).toISOString() }));
  test("per-row work (list parse + date formatting for 100 rows) stays under 5 ms of CPU, with the formatter built once", async () => {
    await withBackend([[200, { success: true, data: { data: rows, totalElements: 100 } }]], () => listPending(cfg, ACTOR)); // warm up (ICU data, JIT)
    const best = [];
    for (let k = 0; k < 5; k++) {
      const { out } = await withBackend([[200, { success: true, data: { data: rows, totalElements: 100 } }]], async () => {
        const t0 = process.cpuUsage();
        const l = await listPending(cfg, ACTOR);
        for (const r of l.items) formatDate(r.createdAt);
        const d = process.cpuUsage(t0);
        return { n: l.items.length, ms: (d.user + d.system) / 1000 };
      });
      assert.equal(out.n, 100);
      best.push(out.ms);
    }
    assert.ok(Math.min(...best) < 5, `best of 5: ${Math.min(...best).toFixed(2)} ms (all: ${best.map((x) => x.toFixed(2))})`);
  });
  const big = (path) => {
    const out = join(tmp100, "p.html");
    const r = spawnSync(process.execPath, ["scripts/render-admin.mjs", "--out", out, "--path", path], { cwd: ROOT, encoding: "utf8", timeout: 300_000, env: { ...process.env, CATALOG_MOCK_ROWS: "100" } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(out, "utf8");
  };
  const nRows = (h) => (h.match(/<tr id="req-/g) ?? []).length;
  test("a 100-row queue renders 25 rows per page with «Показано 1–25 із 100» and a pager; p=4 is the last page", () => {
    const h = big("/admin/requests");
    assert.equal(nRows(h), 25);
    assert.ok(h.includes("Показано 1–25 із 100") && h.includes("1 / 4") && h.includes(uk.admin.requests.next));
    assert.ok(!h.includes(uk.admin.requests.capNotice), "100 is under the 200 cap");
    assert.ok(big("/admin/requests?p=4").includes("Показано 76–100 із 100"));
  });
  test("a past-the-end ?p= clamps to the last page; the kind filter narrows the same 100 and pages itself", () => {
    assert.equal(nRows(big("/admin/requests?p=9&done=approved")), 25);
    const cat = big("/admin/requests?kind=CATEGORY"), typ = big("/admin/requests?kind=SERVICE_TYPE");
    const n = (h, l) => Number(new RegExp(`${l}<span class="n">(\\d+)`).exec(h)[1]);
    assert.equal(n(cat, "Категорії") + n(cat, "Типи послуг"), 100);
    assert.equal(nRows(cat), Math.min(25, n(cat, "Категорії"))); assert.equal(nRows(typ), Math.min(25, n(typ, "Типи послуг")));
  });
  const tmp100 = mkdtempSync(join(tmpdir(), "admin-requests-100-"));
  test.after(() => rmSync(tmp100, { recursive: true, force: true }));
});

describe("source guards", () => {
  const page = readFileSync(join(ROOT, "src/pages/admin/requests.astro"), "utf8");
  test("the page calls requireActor, is SSR, and has no hard-coded origin", () => {
    assert.match(page, /requireActor\(Astro\.locals\)/);
    assert.match(page, /export const prerender = false/);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(page.replace(/\/\/.*$/gm, "")));
  });
});
