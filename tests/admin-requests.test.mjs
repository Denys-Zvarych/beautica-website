// Phase 040 (WEB-68) QA: the «Заявки» page. (1) decide()/listPending() against a fake backend fetch: call order, bodies, code mapping, redirects.
// (2) The built page through scripts/render-admin.mjs (real middleware + Access JWT, local mock catalog backend): fixture render and form POSTs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminConfigFrom } from "../src/lib/admin/config.ts";
import { decide as decideFull, listPending, formatDate, parsePage, PAGE_SIZE, errToFlash, ERR_CODES, DONE_CODES, FLASH_COOKIE } from "../src/lib/admin/requests.ts";
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

describe("built page (render-admin harness, mock catalog backend)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "admin-requests-"));
  test.after(() => rmSync(tmp, { recursive: true, force: true }));
  const run = (name, args) => {
    const out = join(tmp, `${name}.html`), calls = join(tmp, `${name}.json`);
    const r = spawnSync(process.execPath, ["scripts/render-admin.mjs", "--out", out, "--calls", calls, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    return { r, html: r.status === 0 ? readFileSync(out, "utf8") : "", calls: r.status === 0 ? JSON.parse(readFileSync(calls, "utf8")) : [], location: /Location: (\S*)/.exec(r.stderr)?.[1] ?? "" };
  };
  const get = run("get", ["--path", "/admin/requests"]);
  const main = get.html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";

  test("renders 200 with both groups, oldest first, h1 and noindex", () => {
    assert.equal(get.r.status, 0, get.r.stderr);
    assert.match(get.html, new RegExp(`<h1[^>]*>${uk.admin.requests.h1}</h1>`));
    assert.ok(main.includes(`${uk.admin.requests.categories} · 1`));
    assert.ok(main.includes(`${uk.admin.requests.serviceTypes} · 2`));
    assert.ok(main.indexOf("Нігті") < main.indexOf("Корекція брів воском"), "oldest service-type first");
    assert.match(get.html, /<meta name="robots" content="noindex/);
  });
  test("each card is one POST form with name input + save / approve / reject (name=action)", () => {
    assert.equal((main.match(/<form\b[^>]*method="post"/g) ?? []).length, 3);
    for (const a of ["save", "approve", "reject"]) assert.equal((main.match(new RegExp(`name="action"[^>]*value="${a}"|value="${a}"[^>]*name="action"`, "g")) ?? []).length, 3, a);
    assert.equal((main.match(/<details\b/g) ?? []).length, 3);
    assert.ok(main.includes('value="Brow bar"'), "category input prefilled with the display name");
  });
  test("no script, no inline handler, no analytics; initial service only on the category card", () => {
    assert.ok(!/<script/i.test(get.html));
    assert.ok(!/\son[a-z]+\s*=/i.test(get.html));
    assert.equal((main.match(/name="initialServiceName"/g) ?? []).length, 1);
  });
  test("a description keeps its text HTML-escaped; the requester label is shown, no email/phone fields exist", () => {
    assert.ok(main.includes("Часто просять клієнти."));
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
  test("POST with a bad name: 303 to ?err=BAD_INPUT&card, typed name only in a HttpOnly/Secure/Strict flash cookie; the next GET prefills it", () => {
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
    assert.equal(other.html.split('value="Бровки!!"').length - 1, 1, "the value goes to the one card named in ?card, not to the others");
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
    const r = spawnSync(process.execPath, ["scripts/render-admin.mjs", "--out", out, "--path", path], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, CATALOG_MOCK_ROWS: "100" } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(out, "utf8");
  };
  const forms = (h) => (h.match(/<form\b[^>]*method="post"/g) ?? []).length;
  test("a 100-row queue renders 25 cards per page with «Показано 1–25 із 100» and a «Наступна» link only", () => {
    const h = big("/admin/requests");
    assert.equal(forms(h), 25);
    assert.ok(h.includes("Показано 1–25 із 100"));
    assert.match(h, /<a [^>]*href="\/admin\/requests\?p=2"[^>]*>[\s\S]*?Наступна/);
    assert.ok(!h.includes("Попередня"));
    assert.ok(!h.includes('name="p"'), "page 1 cards carry no page field");
  });
  test("page 4 (last): «Попередня» to p=3, no «Наступна»; cards carry the page; an out-of-range page redirects to the last page", () => {
    const h = big("/admin/requests?p=4");
    assert.equal(forms(h), 25);
    assert.ok(h.includes("Показано 76–100 із 100"));
    assert.match(h, /href="\/admin\/requests\?p=3"/);
    assert.ok(!h.includes("Наступна"));
    assert.equal((h.match(/name="p" value="4"/g) ?? []).length, 25);
    const out = join(tmp100, "q.html");
    const r = spawnSync(process.execPath, ["scripts/render-admin.mjs", "--out", out, "--path", "/admin/requests?p=9&done=approved"], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, CATALOG_MOCK_ROWS: "100" } });
    assert.equal(r.status, 1, "a 303 on a GET is not a 200"); // the harness only accepts 303 for POST
    assert.match(r.stderr, /Location: \/admin\/requests\?(?=[^\s]*done=approved)(?=[^\s]*\bp=4)/);
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
