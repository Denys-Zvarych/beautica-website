// Phase 015 QA: the add-to-calendar file is a VALID iCalendar as a whole, the cancel link in it sits on THIS site's origin even when the
// API answers with a foreign host, and the bearer cancel link reaches only the downloaded file (never analytics / storage / history / network).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, mockLog, driveTo } from "./helpers/book.mjs";
import { parseIcs } from "./helpers/ics-parse.mjs";
import { buildIcs } from "../src/scripts/booking/ics.ts";
import { CANCEL_URL, FOREIGN_CANCEL_URL } from "./helpers/mock-api.mjs";

const TOKEN = (u) => new URL(u).pathname.split("/").pop();
const base = { uid: "u", startsAt: "2026-10-23T12:00:00+03:00", minutes: 30, summary: "Запис до Оксани", description: "Послуги: A, B; C.\nСкасувати запис: https://beautica.app/book/cancel/123e4567-e89b-42d3-a456-426614174000", location: "Київ, вул. Хрещатик" };
const now = new Date("2026-10-22T10:00:00Z");

describe("the strict iCalendar reader itself (so a green check means something)", () => {
  const good = buildIcs({ ...base, url: "https://beautica.app/book/cancel/123e4567-e89b-42d3-a456-426614174000" }, now);
  test("accepts the generated file and decodes TEXT values back to the input", () => {
    const p = parseIcs(good);
    assert.equal(p.text.DESCRIPTION, base.description);
    assert.equal(p.text.LOCATION, base.location);
    assert.equal(p.VEVENT.URL, "https://beautica.app/book/cancel/123e4567-e89b-42d3-a456-426614174000");
  });
  for (const [why, bad] of [
    ["bare LF", good.replace("SUMMARY", "\nSUMMARY")],
    ["unknown property", good.replace("URL:", "ATTENDEE:")],
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
    const ics = buildIcs({ ...base, summary: evil, description: evil + "₴😀".repeat(90), location: evil, url: "https://beautica.app/book/cancel/123e4567-e89b-42d3-a456-426614174000" }, now);
    const p = parseIcs(ics);
    assert.equal(p.text.SUMMARY, "a\nATTENDEE:x\nb\nc\nd\ne" + "fg;h,i\\j");
  });
});

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

/** Books through the real flow, clicks «Додати в календар», returns the downloaded text + everything the page remembered. */
async function bookAndDownload(slug) {
  const env = await bookPage(browser, slug, {
    init: () => {
      window.__icsBlobs = [];
      window.__events = [];
      window.umami = { track: (e, p) => window.__events.push({ e, p }) };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => (window.__icsBlobs.push(b), create(b));
    },
  });
  const sent = [];
  env.page.on("request", (r) => sent.push({ url: r.url(), post: r.postData() ?? "", headers: JSON.stringify(r.headers()) }));
  try {
    await driveTo(env.page, "confirm", { contact: { name: "Календар" } });
    await env.page.click("#cta-confirm");
    await env.page.waitForSelector("#done-card", { state: "visible" });
    const before = await snapshot(env.page);
    await env.page.getByRole("button", { name: "Додати в календар" }).click();
    const ics = await env.page.evaluate(() => window.__icsBlobs.at(-1).text());
    const after = await snapshot(env.page);
    const origin = new URL(env.page.url()).origin;
    assert.deepEqual(env.problems.filter((p) => !/status of (409|401|429|503|400)/.test(p)), [], "no console / page errors");
    return { ics, origin, before, after, sent, doneHref: await env.page.locator("#done-cancel").getAttribute("href") };
  } finally {
    await env.context.close();
  }
}
const snapshot = (page) => page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie, h: history.state, u: location.href, n: window.name, e: window.__events, ref: document.referrer }));

describe("downloaded file in the browser", () => {
  test("the whole downloaded .ics is a valid iCalendar; URL + DESCRIPTION line carry the cancel link", async () => {
    const { ics, origin } = await bookAndDownload("oksana-ab12");
    const p = parseIcs(ics);
    const cancel = `${origin}/book/cancel/${TOKEN(CANCEL_URL)}`;
    assert.equal(p.VEVENT.URL, cancel);
    assert.ok(p.text.DESCRIPTION.split("\n").at(-1) === `Скасувати запис: ${cancel}`, p.text.DESCRIPTION);
  });

  test("cancel URL host == the page origin even when the API returns a foreign host; the foreign host, query and fragment never reach the file", async () => {
    const { ics, origin } = await bookAndDownload("foreigncancel-4242");
    const p = parseIcs(ics);
    const cancel = `${origin}/book/cancel/${TOKEN(FOREIGN_CANCEL_URL)}`;
    assert.equal(p.VEVENT.URL, cancel);
    assert.equal(new URL(p.VEVENT.URL).origin, origin);
    assert.equal(/evil-backend|8443|utm|frag/.test(ics.replace(/\r\n /g, "")), false, ics);
    assert.ok(p.text.DESCRIPTION.endsWith(`Скасувати запис: ${cancel}`));
  });

  test("no cancelUrl: a valid file with no URL property and no cancel text", async () => {
    const { ics } = await bookAndDownload("nocancel-8888");
    const p = parseIcs(ics);
    assert.equal("URL" in p.VEVENT, false);
    assert.equal(/Скасувати|book\/cancel/.test(ics), false);
  });

  test("the bearer cancel token appears in no analytics event, storage, cookie, history state, URL or request except the booking response's own page", async () => {
    const { before: b, after: a, sent, doneHref } = await bookAndDownload("oksana-ab12");
    const token = TOKEN(CANCEL_URL);
    assert.ok(doneHref?.endsWith(token), "the done screen itself still offers the cancel link (the test is not vacuous)");
    for (const [when, snap] of [["before download", b], ["after download", a]]) assert.equal(snap.includes(token), false, `${when}: ${snap}`);
    assert.deepEqual(sent.filter((r) => [r.url, r.post, r.headers].some((v) => decodeURIComponent(v).includes(token))), [], "no request carries the token");
    assert.equal((await mockLog((e) => JSON.stringify(e).includes(token))).length, 0, "the mock backend never sees it again");
  });
});
