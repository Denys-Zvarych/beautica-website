// Phase 025: contract of GET /api/ics (src/pages/api/ics.ts) against `wrangler dev` - status codes, headers, validation, truncation, and that the
// calendar file carries the cancel link only from a valid `c` token (own origin), never a phone or guest name. No browser, no mock backend.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { BASE, WRANGLER_LOG, requireBase } from "./helpers/env.mjs";
import { parseIcs } from "./helpers/ics-parse.mjs";

requireBase();
const good = { s: "2026-11-08T12:00:00Z", e: "2026-11-08T13:30:00Z", t: "Запис до Оксани", l: "Київ, вул. Хрещатик, 22", d: "Запис через Beautica. Послуги: Манікюр." };
const get = (params, { method = "GET", headers = {} } = {}) => fetch(`${BASE}/api/ics?${new URLSearchParams(params)}`, { method, headers, redirect: "manual" });
const secured = (res) => {
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
};

describe("GET /api/ics: success", () => {
  test("200, text/calendar, inline beautica-booking.ics, no-store, noindex", async () => {
    const res = await get(good);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(res.headers.get("content-disposition"), 'inline; filename="beautica-booking.ics"');
    secured(res);
    const p = parseIcs(await res.text());
    assert.equal(p.text.SUMMARY, good.t);
    assert.equal(p.text.LOCATION, good.l);
    assert.equal(p.VEVENT.DTSTART, "20261108T120000Z");
    assert.equal(p.VEVENT.DTEND, "20261108T133000Z");
  });
  test("without c the file has no URL property, cancel text, phone or name", async () => {
    const body = await (await get(good)).text();
    assert.equal(/URL:|book\/cancel|Скасувати|\+380|ATTENDEE|ORGANIZER/.test(body), false, body);
  });
  test("c = short or legacy token -> URL property + DESCRIPTION line on the request's own origin", async () => {
    for (const [c, path] of [["Ab3dEf7hJk9mNp2Q", "/c/Ab3dEf7hJk9mNp2Q"], ["123e4567-e89b-42d3-a456-426614174000", "/book/cancel/123e4567-e89b-42d3-a456-426614174000"]]) {
      const res = await get({ ...good, c });
      assert.equal(res.status, 200);
      const p = parseIcs(await res.text());
      assert.equal(p.VEVENT.URL, `${BASE}${path}`);
      assert.ok(p.text.DESCRIPTION.endsWith(`Скасувати запис: ${BASE}${path}`), p.text.DESCRIPTION);
    }
  });
  test("c is a token only: URLs, paths, wrong lengths, empty -> 400", async () => {
    for (const c of ["https://evil.example/x", "/c/Ab3dEf7hJk9mNp2Q", "Ab3dEf7hJk9mNp2", "Ab3dEf7hJk9mNp2QX", "../x", "", "123e4567-e89b-42d3-a456-42661417400g"])
      assert.equal((await get({ ...good, c })).status, 400, c);
  });
  test("a navigation from x-safari (no Origin/Referer, sec-fetch-site none) stays allowed", async () => {
    assert.equal((await get({ ...good, c: "Ab3dEf7hJk9mNp2Q" }, { headers: { "sec-fetch-site": "none" } })).status, 200);
  });
  test("the live file is a PUBLISH calendar with one display alarm one hour before", async () => {
    const body = await (await get(good)).text();
    assert.match(body, /\r\nMETHOD:PUBLISH\r\n/);
    assert.equal(body.match(/BEGIN:VALARM/g)?.length, 1);
    assert.match(body, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:[^\r]+\r\nTRIGGER:-PT1H\r\nEND:VALARM/);
    parseIcs(body);
  });
  test("over-long summary / place / description are cut with «…», not rejected", async () => {
    const res = await get({ ...good, t: "М".repeat(300), l: "в".repeat(400), d: "д".repeat(900) });
    assert.equal(res.status, 200);
    const p = parseIcs(await res.text());
    assert.ok(p.text.SUMMARY.length === 120 && p.text.SUMMARY.endsWith("…"));
    assert.ok(p.text.LOCATION.length === 200 && p.text.LOCATION.endsWith("…"));
    assert.ok(p.text.DESCRIPTION.length === 500 && p.text.DESCRIPTION.endsWith("…"));
  });
  test("line breaks in the query cannot inject properties", async () => {
    const res = await get({ ...good, t: "A\r\nATTENDEE:mailto:x@y.z", d: "b\nURL:https://evil.example" });
    assert.equal(res.status, 200);
    const body = await res.text();
    parseIcs(body); // throws on an unknown property
    assert.equal(/\r\nATTENDEE|\r\nURL:/.test(body), false);
  });
  test("no summary text of the request reaches the server log (nothing stored or logged)", () => {
    if (!WRANGLER_LOG || !existsSync(WRANGLER_LOG)) return;
    assert.equal(readFileSync(WRANGLER_LOG, "utf8").includes(good.l), false);
  });
});

describe("GET /api/ics: 400 on anything malformed", () => {
  const cases = {
    "missing t": { ...good, t: undefined },
    "blank t": { ...good, t: "   " },
    "missing s": { ...good, s: undefined },
    "missing e": { ...good, e: undefined },
    "non-UTC offset": { ...good, s: "2026-11-08T12:00:00+02:00" },
    "date only": { ...good, s: "2026-11-08" },
    "garbage time": { ...good, s: "x" },
    "end equals start": { ...good, e: good.s },
    "end before start": { ...good, e: "2026-11-08T11:00:00Z" },
    "longer than 24 h": { ...good, e: "2026-11-09T12:00:01Z" },
    "year 2019": { ...good, s: "2019-11-08T12:00:00Z", e: "2019-11-08T13:00:00Z" },
    "year 2101": { ...good, s: "2101-11-08T12:00:00Z", e: "2101-11-08T13:00:00Z" },
  };
  for (const [name, params] of Object.entries(cases))
    test(name, async () => {
      const res = await get(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)));
      assert.equal(res.status, 400);
      secured(res);
      assert.equal(res.headers.get("content-disposition"), null);
    });
  test("exactly 24 h and the year bounds 2020 / 2100 are accepted", async () => {
    assert.equal((await get({ ...good, e: "2026-11-09T12:00:00Z" })).status, 200);
    assert.equal((await get({ ...good, s: "2020-01-01T00:00:00Z", e: "2020-01-01T01:00:00Z" })).status, 200);
    assert.equal((await get({ ...good, s: "2100-06-01T00:00:00Z", e: "2100-06-01T01:00:00Z" })).status, 200);
  });
});

describe("GET /api/ics: who may call it, and which methods", () => {
  test("Sec-Fetch-Site: cross-site -> 403 with the same hardening headers", async () => {
    const res = await get(good, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(res.status, 403);
    secured(res);
    assert.equal(res.headers.get("content-type")?.startsWith("text/calendar"), false);
  });
  for (const v of ["same-origin", "same-site", "none"])
    test(`Sec-Fetch-Site: ${v} -> 200`, async () => assert.equal((await get(good, { headers: { "sec-fetch-site": v } })).status, 200));
  test("no Sec-Fetch-Site, foreign Referer -> 403", async () => {
    const res = await get(good, { headers: { referer: "https://evil.example/x" } });
    assert.equal(res.status, 403);
    secured(res);
  });
  test("foreign Origin -> 403", async () => assert.equal((await get(good, { headers: { origin: "https://evil.example" } })).status, 403));
  test("unparsable Referer / Origin -> 403", async () => {
    assert.equal((await get(good, { headers: { referer: "not a url" } })).status, 403);
    assert.equal((await get(good, { headers: { origin: "null" } })).status, 403);
  });
  test("same-host Referer / Origin -> 200", async () => {
    assert.equal((await get(good, { headers: { referer: `${BASE}/book/done` } })).status, 200);
    assert.equal((await get(good, { headers: { origin: new URL(BASE).origin } })).status, 200);
  });
  test("a lookalike host (same prefix, userinfo trick) or a foreign Referer next to a same-host Origin -> 403", async () => {
    const host = new URL(BASE).host;
    assert.equal((await get(good, { headers: { referer: `http://${host}.evil.example/x` } })).status, 403);
    assert.equal((await get(good, { headers: { referer: `http://${host}@evil.example/x` } })).status, 403);
    assert.equal((await get(good, { headers: { origin: new URL(BASE).origin, referer: "https://evil.example/x" } })).status, 403);
  });
  test("no Referer / Origin / Sec-Fetch-Site -> 200", async () => assert.equal((await get(good)).status, 200));
  for (const method of ["POST", "PUT", "DELETE", "PATCH"])
    test(`${method} -> 405, Allow: GET, no-store, noindex`, async () => {
      const res = await get(good, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
      secured(res);
    });
  test("OPTIONS -> 405, Allow: GET, HEAD, no-store, noindex", async () => {
    const res = await get(good, { method: "OPTIONS" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    secured(res);
  });
  test("HEAD valid -> 200, text/calendar, inline, no-store, empty body", async () => {
    const res = await get(good, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(res.headers.get("content-disposition"), 'inline; filename="beautica-booking.ics"');
    secured(res);
    assert.equal(await res.text(), "");
  });
  test("HEAD invalid -> 400, empty body", async () => {
    const res = await get({ ...good, t: "   " }, { method: "HEAD" });
    assert.equal(res.status, 400);
    secured(res);
    assert.equal(await res.text(), "");
  });
  test("HEAD cross-site -> 403", async () => {
    const res = await get(good, { method: "HEAD", headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(res.status, 403);
    secured(res);
  });
});
