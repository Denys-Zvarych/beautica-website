// Phase 038 QA (GST-78): the calendar event of a real two-service visit, end to end in the browser. Title «{first} +1 · {master}», description = the
// intro + one timed line per service + the cancel line; the Google link and the downloaded .ics must say the same, and the .ics must be CRLF-folded / escaped.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open, mockCancelApi } from "./helpers/browser.mjs";
import { BASE, SHORT_TOKEN, uk, requireBase } from "./helpers/env.mjs";
import { bookPage, driveTo, SVC_ID } from "./helpers/book.mjs";
import { parseIcs } from "./helpers/ics-parse.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const nb = (x) => x.replace(/ /g, " ");
const INTRO = uk.book.ics.description;
const LINE = /^\d{2}:\d{2} (.+) · (.+)$/;

/** Google link + downloaded .ics of one chooser; returns both decoded. */
async function readBoth(page, scope) {
  const g = new URL(await page.locator(`${scope} [data-cal="google"]`).getAttribute("href"));
  const apple = await page.locator(`${scope} [data-cal="apple"]`).getAttribute("href");
  const res = await page.request.get(new URL(apple, BASE).href);
  assert.equal(res.status(), 200);
  const raw = await res.text();
  return { g, raw, ics: parseIcs(raw) };
}

/** Same lines in both carriers: intro, 2 timed lines naming both services, then the cancel line; title with «+1». */
function assertEvent({ g, raw, ics }, { first, second, master }) {
  const title = nb(`${first} +1 · ${master}`);
  assert.equal(nb(g.searchParams.get("text")), title, "Google text");
  assert.equal(nb(ics.text.SUMMARY), title, ".ics SUMMARY");
  const gLines = nb(g.searchParams.get("details")).split("\n");
  assert.equal(gLines[0], INTRO);
  assert.match(gLines[1], LINE);
  assert.match(gLines[2], LINE);
  assert.ok(gLines[1].includes(` ${first} · `) && gLines[2].includes(` ${second} · `), `lines name both services: ${gLines}`);
  assert.equal(gLines.length, 4, "intro + 2 service lines + cancel line");
  assert.ok(gLines[3].startsWith(`${uk.book.ics.cancel}: `), "cancel line last");
  const dLines = nb(ics.text.DESCRIPTION).split("\n");
  assert.deepEqual(dLines.slice(0, 3), gLines.slice(0, 3), ".ics DESCRIPTION has the same intro + service lines as the Google details");
  assert.equal(dLines.length, 4);
  assert.ok(dLines[3].startsWith(`${uk.book.ics.cancel}: `), ".ics cancel line last");
  // Wire format: CRLF everywhere, the long DESCRIPTION is folded (continuation = CRLF + space), real newlines are escaped as \n inside the value.
  assert.equal(/(^|[^\r])\n/.test(raw), false, "no bare LF");
  assert.ok(raw.includes("\r\n "), "long DESCRIPTION folded");
  assert.ok(ics.VEVENT.DESCRIPTION.includes("\\n"), "line breaks escaped as \\n");
}

describe("GST-78: calendar event of a two-service visit", () => {
  test("master done screen: Google link and .ics carry «{first} +1 · {master}» and the same timed lines + cancel line", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 360 });
    try {
      await driveTo(env.page, "confirm", { services: [SVC_ID.classic, SVC_ID.gel], contact: { name: "Подвійний", phone: "500000738" } });
      await env.page.click("#cta-confirm");
      await env.page.waitForSelector("#done-card", { state: "visible" });
      const both = await readBoth(env.page, "#done-card");
      const title = both.g.searchParams.get("text");
      assert.match(nb(title), /^.+ \+1 · Оксана Коваленко$/);
      const [first, second] = nb(both.g.searchParams.get("details")).split("\n").slice(1, 3).map((l) => LINE.exec(l)[1]);
      assertEvent(both, { first, second, master: "Оксана Коваленко" });
    } finally {
      await env.context.close();
    }
  });

  test("/c/{token}?n=1 («Додати в календар» from the token GET): per-item startsAt lines, Google and .ics identical in content", async () => {
    const INFO = {
      masterName: "Олена Коваль", serviceName: "Манікюр, Педикюр", startsAt: "2030-03-05T10:00:00Z", cancellable: true, windowClosesAt: "2030-03-05T08:00:00Z", status: "CONFIRMED",
      items: [
        { bookingId: "11111111-1111-4111-8111-111111111111", serviceName: "Манікюр", startsAt: "2030-03-05T10:00:00Z", durationMinutes: 60, status: "CONFIRMED", cancellable: true },
        { bookingId: "22222222-2222-4222-8222-222222222222", serviceName: "Педикюр", startsAt: "2030-03-05T11:15:00Z", durationMinutes: 30, status: "CONFIRMED", cancellable: true },
      ],
    };
    const env = await open(browser, { width: 360, height: 800 });
    await mockCancelApi(env.context, { get: () => ({ status: 200, json: INFO }) });
    try {
      await env.page.goto(`${BASE}/c/${SHORT_TOKEN}?n=1`);
      await env.page.waitForSelector("#c-cal .calbtn", { state: "visible" });
      const both = await readBoth(env.page, "#c-cal");
      assert.equal(nb(both.g.searchParams.get("details")).split("\n")[1], "12:00 Манікюр · 1 год", "Kyiv winter time (UTC+2)");
      // 11:15Z is NOT 11:00Z (end of the first): the second line must use its own startsAt, not a chain.
      assert.equal(nb(both.g.searchParams.get("details")).split("\n")[2], "13:15 Педикюр · 30 хв");
      assertEvent(both, { first: "Манікюр", second: "Педикюр", master: "Олена Коваль" });
    } finally {
      await env.context.close();
    }
  });
});
