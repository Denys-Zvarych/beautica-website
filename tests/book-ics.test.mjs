// Phase 025 QA: the add-to-calendar file is a VALID iCalendar as a whole and carries NO cancel link, phone or guest name; the done screen
// links to GET /api/ics (a plain <a href>, no token in it) and the bearer cancel link never reaches the file, the URL, analytics, storage or the network.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, mockLog, driveTo } from "./helpers/book.mjs";
import { parseIcs } from "./helpers/ics-parse.mjs";
import { buildIcs } from "../src/scripts/booking/ics.ts";
import { calendarLinks, calendarOrder } from "../src/scripts/booking/calendar-links.ts";
import { CANCEL_URL, FOREIGN_CANCEL_URL } from "./helpers/mock-api.mjs";

const TOKEN = (u) => new URL(u).pathname.split("/").pop();
const base = { uid: "u", startsAt: "2026-10-23T12:00:00+03:00", minutes: 30, summary: "Запис до Оксани", description: "Послуги: A, B; C.", location: "Київ, вул. Хрещатик" };
const now = new Date("2026-10-22T10:00:00Z");

describe("the strict iCalendar reader itself (so a green check means something)", () => {
  const good = buildIcs(base, now);
  test("accepts the generated file and decodes TEXT values back to the input", () => {
    const p = parseIcs(good);
    assert.equal(p.text.DESCRIPTION, base.description);
    assert.equal(p.text.LOCATION, base.location);
    assert.equal("URL" in p.VEVENT, false, "buildIcs emits no URL property any more");
  });
  for (const [why, bad] of [
    ["bare LF", good.replace("SUMMARY", "\nSUMMARY")],
    ["unknown property", good.replace("LOCATION:", "ATTENDEE:")],
    ["a URL property (the cancel link must never be in the file)", good.replace("END:VEVENT", "URL:https://beautica.app/book/cancel/x\r\nEND:VEVENT")],
    ["unescaped comma", good.replace("LOCATION:Київ\\,", "LOCATION:Київ,")],
    ["over-long line", good.replace("PRODID:", "PRODID:" + "x".repeat(80))],
    ["no trailing CRLF", good.slice(0, -2)],
    ["bad escape", good.replace("SUMMARY:Запис", "SUMMARY:\\xЗапис")],
    ["unbalanced", good.replace("END:VEVENT\r\n", "")],
  ])
    test(`rejects: ${why}`, () => assert.throws(() => parseIcs(bad), /invalid iCalendar/));
});

describe("buildIcs output parses as one valid VEVENT for hostile input too", () => {
  test("every TEXT field hostile (CR, LF, U+2028/2029/0085, C0/C1, ; , \\) + a very long multi-byte description", () => {
    const evil = "a\rATTENDEE:x\nb\u2028c\u2029d\u0085e\u0000f\u0090g;h,i\\j";
    const ics = buildIcs({ ...base, summary: evil, description: evil + "₴😀".repeat(90), location: evil }, now);
    const p = parseIcs(ics);
    assert.equal(p.text.SUMMARY, "a\nATTENDEE:x\nb\nc\nd\ne" + "fg;h,i\\j");
  });
});

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

/** Books through the real flow, taps the calendar LINK, returns the downloaded text + everything the page remembered. */
async function bookAndDownload(slug) {
  const env = await bookPage(browser, slug, {
    acceptDownloads: true,
    init: () => {
      window.__events = [];
      window.umami = { track: (e, p) => window.__events.push({ e, p }) };
    },
  });
  const sent = [];
  env.page.on("request", (r) => sent.push({ url: r.url(), post: r.postData() ?? "", headers: JSON.stringify(r.headers()) }));
  try {
    await driveTo(env.page, "confirm", { contact: { name: "Календар" } });
    await env.page.click("#cta-confirm");
    await env.page.waitForSelector("#done-card", { state: "visible" });
    const before = await snapshot(env.page);
    const link = env.page.getByRole("link", { name: "Календар Apple" });
    const href = await link.getAttribute("href");
    const [download] = await Promise.all([env.page.waitForEvent("download"), link.click()]);
    // The browser saved the file (its name is asserted); the bytes are read with the page's own request context from the same href.
    const res = await env.page.request.get(new URL(href, env.page.url()).href);
    assert.equal(res.status(), 200);
    const ics = await res.text();
    const after = await snapshot(env.page);
    assert.deepEqual(env.problems.filter((p) => !/status of (409|401|429|503|400)/.test(p) && !/requestfailed: \S+\/api\/ics\?\S+ net::ERR_ABORTED/.test(p)), [], "no console / page errors (a download aborts its navigation: expected)");
    return { ics, href, filename: download.suggestedFilename(), before, after, sent, text: await env.page.locator("#done-card").innerText() };
  } finally {
    await env.context.close();
  }
}
const snapshot = (page) => page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie, h: history.state, u: location.href, n: window.name, e: window.__events, ref: document.referrer }));

describe("calendar link in the browser", () => {
  test("«Додати в календар» is a plain link to /api/ics (no JS handler needed, no token in the href) and downloads beautica-booking.ics", async () => {
    const { ics, href, filename } = await bookAndDownload("oksana-ab12");
    const u = new URL(href, "https://x.example");
    assert.equal(u.pathname, "/api/ics");
    assert.deepEqual([...u.searchParams.keys()].sort(), ["d", "e", "l", "s", "t"].filter((k) => u.searchParams.has(k)));
    assert.ok(u.searchParams.has("s") && u.searchParams.has("e") && u.searchParams.has("t"));
    assert.equal(href.includes(TOKEN(CANCEL_URL)) || /cancel/i.test(href), false, href);
    assert.equal(filename, "beautica-booking.ics");
    const p = parseIcs(ics);
    assert.match(p.text.SUMMARY, /^Запис до /);
  });

  test("the file has NO cancel link, no URL property, no guest name or phone", async () => {
    const { ics } = await bookAndDownload("oksana-ab12");
    const p = parseIcs(ics);
    assert.equal("URL" in p.VEVENT, false);
    assert.equal(/Скасувати|book\/cancel|123e4567|Календар|\+?380|50\d{7}/.test(ics.replace(/\r\n /g, "")), false, ics);
  });

  test("a foreign cancel host from the API never reaches the file or the link", async () => {
    const { ics, href } = await bookAndDownload("foreigncancel-4242");
    assert.equal(/evil-backend|8443|utm|frag|aaaaaaaa-bbbb/.test(ics.replace(/\r\n /g, "") + href), false);
  });

  test("the bearer cancel token appears in no analytics event, storage, cookie, history state, URL or request; the done screen shows no cancel text", async () => {
    const { before: b, after: a, sent, text, href } = await bookAndDownload("oksana-ab12");
    const token = TOKEN(CANCEL_URL);
    for (const [when, snap] of [["before", b], ["after", a]]) assert.equal(snap.includes(token), false, `${when}: ${snap}`);
    assert.deepEqual(sent.filter((r) => [r.url, r.post, r.headers].some((v) => decodeURIComponent(v).includes(token))), [], "no request carries the token");
    assert.equal(text.includes(token) || href.includes(token), false);
    assert.equal((await mockLog((e) => JSON.stringify(e).includes(token))).length, 0, "the mock backend never sees it again");
  });
});

describe("GET /api/ics: over-long real bookings are cut, not rejected (phase 025)", async () => {
  const { GET } = await import("../src/pages/api/ics.ts");
  const call = (params, headers = {}) => GET({ url: new URL(`https://beautica.app/api/ics?${new URLSearchParams(params)}`), request: new Request("https://beautica.app/api/ics", { headers }) });
  const times = { s: "2026-11-08T12:00:00Z", e: "2026-11-08T13:00:00Z" };
  test("10 long service names + long place -> 200, DESCRIPTION capped with an ellipsis", async () => {
    const d = "Послуги: " + Array.from({ length: 10 }, (_, i) => `Дуже довга назва послуги номер ${i}`.repeat(2)).join(", ");
    const res = await call({ ...times, t: "Запис до " + "М".repeat(200), l: "вул. ".repeat(100), d });
    assert.equal(res.status, 200);
    const p = parseIcs(await res.text());
    assert.ok(p.text.DESCRIPTION.length <= 500 && p.text.DESCRIPTION.endsWith("…"), p.text.DESCRIPTION.length);
    assert.ok(p.text.SUMMARY.length <= 120 && p.text.LOCATION.length <= 200);
  });
  test("missing t, bad times, year out of range -> 400; cross-site -> 403; same-origin / none / absent -> 200", async () => {
    assert.equal((await call({ ...times })).status, 400);
    assert.equal((await call({ s: "x", e: times.e, t: "A" })).status, 400);
    assert.equal((await call({ s: "2019-11-08T12:00:00Z", e: "2019-11-08T13:00:00Z", t: "A" })).status, 400);
    assert.equal((await call({ s: "2101-11-08T12:00:00Z", e: "2101-11-08T13:00:00Z", t: "A" })).status, 400);
    assert.equal((await call({ ...times, t: "A" }, { "sec-fetch-site": "cross-site" })).status, 403);
    for (const v of ["same-origin", "none", "same-site"]) assert.equal((await call({ ...times, t: "A" }, { "sec-fetch-site": v })).status, 200, v);
    assert.equal((await call({ ...times, t: "A" })).status, 200);
  });
});

describe("calendar chooser: Google / Apple .ics (works in in-app webviews)", () => {
  const ev = { startsAt: "2026-11-08T12:00:00.000Z", minutes: 90, title: "Запис до Оксани", description: "Запис через Beautica. Послуги: A, B.", location: "Київ, вул. Хрещатик" };
  const links = calendarLinks(ev);
  test("Google link: TEMPLATE with UTC dates, ctz, text, details, location", () => {
    const u = new URL(links.google);
    assert.equal(u.origin + u.pathname, "https://calendar.google.com/calendar/render");
    assert.equal(u.searchParams.get("action"), "TEMPLATE");
    assert.equal(u.searchParams.get("ctz"), "Europe/Kyiv");
    assert.equal(u.searchParams.get("dates"), "20261108T120000Z/20261108T133000Z");
    assert.equal(u.searchParams.get("text"), ev.title);
    assert.equal(u.searchParams.get("details"), ev.description);
    assert.equal(u.searchParams.get("location"), ev.location);
    assert.deepEqual(Object.keys(links).sort(), ["apple", "google"]);
  });
  test("Android: Google link is an intent:// to the Calendar app with the exact https template as fallback; iOS / desktop keep plain https", () => {
    const https = links.google;
    const droid = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Instagram 300.0";
    const href = calendarLinks(ev, droid).google;
    const [head, frag] = href.split("#");
    const hu = new URL(https);
    assert.equal(head, `intent://${hu.host}${hu.pathname}${hu.search}`);
    assert.match(frag, /^Intent;scheme=https;package=com\.google\.android\.calendar;S\.browser_fallback_url=[^;]+;end$/);
    assert.equal(decodeURIComponent(frag.match(/S\.browser_fallback_url=([^;]+);end/)[1]), https);
    assert.equal(new URL("https://x" + head.slice("intent://calendar.google.com".length)).searchParams.get("dates"), "20261108T120000Z/20261108T133000Z");
    assert.equal(calendarLinks(ev, droid).apple, links.apple, "the .ics link is untouched");
    for (const ua of ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", "Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0.0.0 Safari/537.36", ""]) assert.equal(calendarLinks(ev, ua).google, https, ua);
  });
  test("apple link stays /api/ics; long input is capped (t 120, l 200, d 500)", () => {
    assert.match(links.apple, /^\/api\/ics\?s=/);
    const l = calendarLinks({ ...ev, title: "М".repeat(300), description: "Д".repeat(900), location: "Л".repeat(400) });
    assert.equal(new URL(l.google).searchParams.get("text").length, 120);
    assert.equal(new URL(l.google).searchParams.get("details").length, 500);
    assert.equal(new URL(l.google).searchParams.get("location").length, 200);
  });
  test("the file has METHOD:PUBLISH and a -PT1H display alarm, and still no URL / name / phone", () => {
    const ics = buildIcs(base, now);
    assert.match(ics, /\r\nMETHOD:PUBLISH\r\n/);
    assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:[^\r]+\r\nTRIGGER:-PT1H\r\nEND:VALARM/);
    parseIcs(ics);
  });
  test("order: Apple devices -> .ics first; Android, desktop, Chrome on Linux -> Google first; always both", () => {
    const UAS = {
      safari: ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "apple"],
      mac: ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "apple"],
      android: ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "google"],
      linux: ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "google"],
    };
    for (const [n, [ua, first]] of Object.entries(UAS)) {
      const o = calendarOrder(ua);
      assert.equal(o[0], first, n);
      assert.deepEqual([...o].sort(), ["apple", "google"], n);
    }
  });
  test("done screen: two links (Google new tab, Apple .ics), both noopener noreferrer, >= 48 px, no cancel link / phone / name", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 360 });
    try {
      await driveTo(env.page, "confirm", { contact: { name: "Календар" } });
      await env.page.click("#cta-confirm");
      await env.page.waitForSelector("#done-card", { state: "visible" });
      const rows = await env.page.locator("[data-screen=done] .calbtn").evaluateAll((as) => as.map((a) => ({ k: a.dataset.cal, href: a.href, target: a.target, rel: a.rel, r: a.getBoundingClientRect().toJSON() })));
      assert.deepEqual(rows.map((r) => r.k).sort(), ["apple", "google"]);
      assert.ok(Math.abs(rows[0].r.y - rows[1].r.y) < 1 && Math.abs(rows[0].r.width - rows[1].r.width) < 1, "ONE row at 360 px, equal width");
      assert.equal(await env.page.evaluate(() => [...document.querySelectorAll("[data-screen=done] .calbtn .t-strong115")].every((e) => e.scrollWidth <= e.clientWidth + 1)), true, "labels not clipped");
      if (process.env.CAL_SHOT) await env.page.locator("#done-card").screenshot({ path: process.env.CAL_SHOT });
      for (const r of rows) {
        assert.ok(r.r.width > 0 && r.r.height >= 47.99, `${r.k} box ${r.r.height}`);
        assert.equal(/cancel|\+?380|50\d{7}/.test(decodeURIComponent(r.href)), false, r.href);
        assert.equal(r.rel, "noopener noreferrer");
        if (r.k === "google") assert.equal(r.target, "_blank");
      }
      assert.equal(await env.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally {
      await env.context.close();
    }
  });

  const UA_PLATFORM = {
    iphone: ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", ["apple", "google"]],
    mac: ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", ["apple", "google"]],
    android: ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", ["google", "apple"]],
    linux: ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", ["google", "apple"]],
  };
  for (const [name, [userAgent, order]] of Object.entries(UA_PLATFORM))
    test(`done screen on ${name}: buttons render ${order.join(" then ")} (left to right), Google href ${name === "android" ? "is an intent://" : "is https"}, no cancel token or phone in either href`, async () => {
      const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent });
      try {
        await driveTo(env.page, "confirm", { contact: { name: "Порядок" } });
        await env.page.click("#cta-confirm");
        await env.page.waitForSelector("#done-card", { state: "visible" });
        const btns = await env.page.locator("[data-screen=done] .calbtn").evaluateAll((as) => as.map((a) => ({ k: a.dataset.cal, x: a.getBoundingClientRect().x, href: a.getAttribute("href") })));
        assert.deepEqual(btns.sort((a, b) => a.x - b.x).map((b) => b.k), order);
        const google = btns.find((b) => b.k === "google").href;
        assert.equal(google.startsWith(name === "android" ? "intent://calendar.google.com/calendar/render?" : "https://calendar.google.com/calendar/render?"), true, google);
        if (name === "android") assert.match(google, /;package=com\.google\.android\.calendar;S\.browser_fallback_url=https%3A%2F%2Fcalendar\.google\.com%2F[^;]+;end$/);
        for (const b of btns) assert.equal(/cancel|123e4567|\+?380|50\d{7}/i.test(decodeURIComponent(b.href)), false, b.href);
      } finally {
        await env.context.close();
      }
    });
});
