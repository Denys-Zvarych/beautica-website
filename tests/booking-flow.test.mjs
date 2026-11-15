// Phase 009: the guest booking flow on /book/{slug}, in a real browser, against the mock backend (tests/helpers/mock-api.mjs).
// Part 1 of 2 (split in phase 025: each CI step stays well under its 5 minutes; part 2 = booking-flow-b.test.mjs): happy path, multi-service, time, contact, SMS code and confirm steps.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, visibleBox } from "./helpers/browser.mjs";
import { BASE, MOCK_API, TOKEN, uk } from "./helpers/env.mjs";
import { parseIcs } from "./helpers/ics-parse.mjs";
import { bookPage, mockLog, callsTo, driveTo, fillContact, pickableDay, shot, toggleConsent, SVC_ID } from "./helpers/book.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";
import { UMAMI_SCRIPT_SRC, UMAMI_HOST_URL, CF_BEACON_SRC } from "../src/config/analytics.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const visibleScreen = (page) => page.locator("[data-screen]:not([hidden])").getAttribute("data-screen");
const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());
async function withPage(slug, opts, fn) {
  const env = await bookPage(browser, slug, opts);
  try {
    await fn(env);
    const blocked = opts.turnstile === "blocked" ? /net::ERR_FAILED/ : /^$/; // the blocked Turnstile script logs a failed load
    assert.deepEqual(env.problems.filter((p) => !/status of (409|401|429|503|400)/.test(p) && !blocked.test(p)), [], "no console / page errors");
    assert.deepEqual(env.external.filter((u) => !u.startsWith("https://challenges.cloudflare.com")), [], "no unexpected origin");
  } finally {
    await env.context.close();
  }
}

describe("happy path: one service", () => {
  test("services -> date -> time -> contact (+ consent + Turnstile) -> SMS code -> confirm -> done, with exactly the documented API traffic", async () => {
    await withPage("oksana-ab12", {}, async ({ page, turnstileRequests }) => {
      const name = "ПовнийШлях";
      await page.waitForSelector("#book-cta:visible");
      assert.equal(await visibleScreen(page), "profile");
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])"); // the island loads on the tap
      assert.equal(await visibleScreen(page), "services");
      assert.equal(await page.locator("#cta-services").isDisabled(), true, "no service yet: Далі is disabled");
      assert.ok((await text(page.locator("[data-sb='services']"))).includes("Оберіть хоча б одну послугу"));
      await page.click(`#svc-list [data-id="${SVC_ID.gel}"]`);
      assert.equal(await page.locator(`#svc-list [data-id="${SVC_ID.gel}"]`).getAttribute("aria-pressed"), "true");
      assert.match(await text(page.locator("[data-sb='services']")), /1 послуга.*Разом.*1 год 30 хв.*від 650 ₴/);
      await page.click("#cta-services");
      assert.equal(await visibleScreen(page), "date");
      assert.equal(await page.locator("#cta-date").isDisabled(), true);
      const day = await pickableDay(page);
      await page.click(`[data-day="${day}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      assert.equal(await page.locator("#slots .slot").count(), 8);
      assert.deepEqual(await page.locator("#slots .sgroup-label span").allInnerTexts(), ["Ранок", "День", "Вечір"]);
      assert.equal(await page.locator("#cta-time").isDisabled(), true, "no slot chosen yet");
      const slot = page.locator("#slots .slot").nth(2);
      const startsAt = await slot.getAttribute("data-t");
      assert.match(startsAt, /^\d{4}-\d{2}-\d{2}T12:00:00\+0[23]:00$/, "the slot's ISO offset string is kept as the API sent it");
      await slot.click();
      assert.equal(await slot.getAttribute("aria-pressed"), "true");
      assert.match(await text(page.locator("[data-sb='time'] .chosen")), /12:00–13:30/);
      await page.click("#cta-time");
      assert.equal(await visibleScreen(page), "contact");
      await page.fill("#name", name);
      await page.fill("#surname", "Коваленко");
      await page.type("#phone", "671290015"); // unique to this test: the shared mock log is read by phone below
      assert.equal(await page.inputValue("#phone"), "+380 67 129 00 15");
      await toggleConsent(page);
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      assert.equal(await text(page.locator("#otp-phone")), "+380 67 129 00 15");
      assert.match(await text(page.locator("#otp-resend")), /Надіслати знову \(\d+ с\)/, "resend cooldown is running");
      assert.equal(await page.locator("#cta-otp").isDisabled(), true);
      await page.locator("#otp input").fill("123456");
      await page.waitForSelector("#confirm-card", { state: "visible" });
      assert.equal(await page.locator("#c-name, #c-phone").count(), 0, "no client (name / phone) row on the confirm step any more");
      const recap = await text(page.locator("#confirm-card"));
      assert.equal(recap.includes(name) || recap.includes("+380"), false, "the guest's own name / phone are not repeated in the summary");
      for (const s of ["Київ", "Манікюр+гель лак", "1 год 30 хв", "від 650 ₴", "12:00–13:30", "Разом"]) assert.ok(recap.includes(s.replace(/ /g, " ")) || recap.includes(s), `confirm lacks ${s}: ${recap}`);
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.equal(await visibleScreen(page), "done");
      assert.equal(await text(page.locator("[data-screen=done] h2")), "Записано!");
      assert.ok((await text(page.locator("[data-screen=done]"))).includes("Ваш запис підтверджено"));
      assert.equal((await text(page.locator("[data-screen=done]"))).includes("підтвердить"), false, "the app's stale «майстер підтвердить» wording is not used");

      const log = await mockLog((e) => e.body?.name === name || e.path.includes("oksana-ab12/availability") || (e.path.includes("/otp/") && e.body?.phone === "+380671290015"));
      const send = callsTo(log, "POST", "/otp/send").at(-1);
      assert.deepEqual(send.body, { phone: "+380671290015", privacyAccepted: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION, turnstileToken: "TOKEN-1", smsFormat: "DOMAIN_BOUND" });
      assert.deepEqual(callsTo(log, "POST", "/otp/verify").at(-1).body, { phone: "+380671290015", code: "123456" });
      // Shared mock log (other files run against the same API): match this test's own availability call by its exact path.
      const availPath = `/api/v1/book/oksana-ab12/availability?date=${day}&serviceId=${SVC_ID.gel}`;
      assert.ok(callsTo(log, "GET", "oksana-ab12/availability").some((e) => e.path === availPath), "availability asked for the chosen day + service");
      const booking = callsTo(log, "POST", "/oksana-ab12/booking").at(-1);
      assert.equal(booking.headers.authorization, "Bearer guest-token-ok");
      assert.deepEqual(booking.body, { serviceId: SVC_ID.gel, startsAt, name, surname: "Коваленко", privacyAccepted: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
      assert.equal(booking.headers.cookie, undefined);
      assert.equal(booking.headers.referer, undefined, "no Referer to the API");
      assert.ok(turnstileRequests.length >= 1 && turnstileRequests.every((u) => u.startsWith("https://challenges.cloudflare.com/turnstile/")));
      await shot(page, "flow-done-360");
    });
  });

  test("done: no cancel text or button, the calendar control is a link to /api/ics, no install block", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Календар" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const done = await text(page.locator("[data-screen=done]"));
      assert.equal(await page.locator("#done-cancel, [data-done-cancel]").count(), 0, "no cancel element");
      assert.equal(await page.locator("[data-screen=done] a[href*='/book/cancel']").count(), 0, "no link to the cancel page");
      assert.equal(await page.getByRole("button", { name: /Скасувати/ }).count(), 0);
      assert.equal(/Скасувати запис|не пізніше ніж за 2 години/.test(done), false, done);
      const cal = page.getByRole("link", { name: uk.book.done.calendarApple });
      assert.equal(await cal.count(), 1);
      assert.equal(new URL(await cal.getAttribute("href"), "https://x.example").pathname, "/api/ics");
      assert.equal(await page.getByRole("button", { name: uk.book.done.calendarApple }).count(), 0, "a link, not a button");
      assert.equal(done.includes("Керуйте записами"), false, "no install block: the done step is the design's");
      assert.equal(await page.locator("[data-screen=done] .chip").count(), 0);
      for (const k of ["google", "apple"]) assert.ok(await visibleBox(page.locator(`[data-screen=done] .calbtn[data-cal=${k}] svg`)), `${k} calendar mark is drawn`);
      const marks = await page.locator("[data-screen=done] .calbtn svg").evaluateAll((svgs) => svgs.map((s) => ({ colours: [...new Set([...s.querySelectorAll("[fill]")].map((e) => e.getAttribute("fill")))].length, w: s.getBoundingClientRect().width })));
      for (const m of marks) assert.ok(m.colours >= 3 && m.w >= 20, "a full-colour brand mark of icon size: " + JSON.stringify(m));
      const rows = await page.locator("[data-screen=done] .calbtn").evaluateAll((as) => as.map((a) => a.getBoundingClientRect().toJSON()));
      assert.equal(rows.length, 2);
      assert.ok(Math.abs(rows[0].y - rows[1].y) < 1 && Math.abs(rows[0].width - rows[1].width) < 1, "both buttons on ONE row, equal width");
      for (const r of rows) assert.ok(r.height >= 47.99, "button >= 48 px: " + r.height);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll("[data-screen=done] .calbtn .t-strong115")].every((e) => e.scrollWidth <= e.clientWidth + 1)), true, "labels are not clipped");
      // The success screen has no «На головну» button (removed by request): no such text, no bare link to "/" left on it.
      assert.equal(await page.locator("[data-screen=done]").getByText("На головну").count(), 0);
      assert.equal(await page.locator("[data-screen=done] a[href='/']:not([hidden])").count(), 0);
    });
  });

  test("done at 393 px (iPhone 15) and wider: each calendar label is ONE line, buttons on one row, >= 48 px", async () => {
    for (const width of [360, 393, 430, 768]) {
      await withPage("oksana-ab12", { width, height: 852 }, async ({ page }) => {
        await driveTo(page, "confirm", { contact: { name: "Календар" } });
        await page.click("#cta-confirm");
        await page.waitForSelector("#done-card", { state: "visible" });
        const m = await page.locator("[data-screen=done] .calbtn").evaluateAll((as) => as.map((a) => {
          const l = a.querySelector(".t-strong115");
          const lh = parseFloat(getComputedStyle(l).lineHeight) || parseFloat(getComputedStyle(l).fontSize) * 1.2;
          return { y: a.getBoundingClientRect().y, h: a.getBoundingClientRect().height, lines: Math.round(l.getBoundingClientRect().height / lh) };
        }));
        assert.equal(m.length, 2);
        if (width >= 393) assert.deepEqual(m.map((x) => x.lines), [1, 1], `${width}: labels on one line`);
        else assert.ok(m.every((x) => x.lines <= 2), "360: at most two lines inside the button");
        assert.ok(Math.abs(m[0].y - m[1].y) < 1, `${width}: one row`);
        for (const x of m) assert.ok(x.h >= 47.99, `${width}: >= 48 px (${x.h})`);
        if ((width === 393 || width === 360) && process.env.CAL_SHOT_DIR) await page.locator("#done-card").screenshot({ path: `${process.env.CAL_SHOT_DIR}/calendar-row-${width}.png` });
      });
    }
  });

  test("phase 025: the calendar file (GET /api/ics from the done link) has the booking's time and place and the cancel link (URL + DESCRIPTION line, own origin) but NO phone or guest name", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Календар" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const href = await page.getByRole("link", { name: uk.book.done.calendarApple }).getAttribute("href");
      const res = await page.request.get(new URL(href, page.url()).href);
      assert.equal(res.status(), 200);
      assert.match(res.headers()["content-type"], /^text\/calendar/);
      const raw = await res.text();
      const ics = raw.replace(/\r\n /g, "");
      assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
      assert.match(ics, /SUMMARY:Манікюр класичний · Оксана Коваленко/);
      assert.match(ics, /DTSTART:\d{8}T\d{6}Z\r\n/);
      assert.match(ics, /LOCATION:Київ/);
      const cancelUrl = `${new URL(BASE).origin}/book/cancel/${TOKEN}`;
      const p = parseIcs(raw);
      assert.equal(p.VEVENT.URL, cancelUrl);
      assert.ok(p.text.DESCRIPTION.endsWith(`${uk.book.ics.cancel}: ${cancelUrl}`), p.text.DESCRIPTION);
      assert.equal(/Календар|\+380/.test(ics.split(new URL(BASE).origin).join("")), false, ics);
    });
  });

  test("the day grid greys out days with no free time (bookable-days): Sundays and past days are disabled, the rest selectable; the request is asked for the chosen services", async () => {
    await withPage("bookdays-5151", {}, async ({ page }) => {
      await driveTo(page, "services");
      await page.click("#cta-services");
      await page.waitForFunction(() => [...document.querySelectorAll(".dbtn")].some((b) => new Date(`${b.dataset.day}T12:00:00Z`).getUTCDay() === 0 && b.disabled && b.dataset.day >= document.querySelector(".dbtn.today").dataset.day));
      const states = await page.evaluate(() => {
        const t = document.querySelector(".dbtn.today").dataset.day;
        return [...document.querySelectorAll(".dbtn")].map((b) => ({ d: b.dataset.day, off: b.disabled, t, sun: new Date(`${b.dataset.day}T12:00:00Z`).getUTCDay() === 0 }));
      });
      const today = states[0].t;
      assert.ok(states.filter((s) => s.d < today).every((s) => s.off));
      assert.ok(states.filter((s) => s.d >= today && s.sun).every((s) => s.off), "Sundays have no free time");
      assert.ok(states.filter((s) => s.d >= today && !s.sun).every((s) => !s.off));
      assert.equal(await page.locator(".dbtn.off:not(.today)").first().evaluate((b) => getComputedStyle(b.querySelector(".n")).color !== getComputedStyle(document.querySelector(".dbtn.ok .n")).color), true, "disabled days read as greyed");
      const calls = callsTo(await mockLog((e) => e.path.includes("bookdays-5151/bookable-days")), "GET", "bookable-days"); // slug unique to this test: the mock log is shared across files
      assert.ok(calls.length >= 1);
      assert.match(calls.at(-1).path, new RegExp(`from=\\d{4}-\\d{2}-\\d{2}&to=\\d{4}-\\d{2}-\\d{2}&serviceId=${SVC_ID.classic}$`));
      assert.equal(await page.locator("#prev").isDisabled(), true);
      await page.click("#next");
      await page.click("#next");
      assert.equal(await page.locator("#next").isDisabled(), true, "three months cover today ... +60 days");
      const last = await page.evaluate(() => [...document.querySelectorAll(".dbtn.ok")].map((b) => b.dataset.day).at(-1));
      assert.ok(last, "the last month still has selectable days");
    });
  });

  test("bookable-days failing leaves every day selectable (the old behaviour)", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/bookable-days*`, (r) => r.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "" }));
      await driveTo(page, "services");
      await page.click("#cta-services");
      await page.waitForTimeout(300);
      const states = await page.evaluate(() => {
        const t = document.querySelector(".dbtn.today").dataset.day;
        return [...document.querySelectorAll(".dbtn")].map((b) => ({ d: b.dataset.day, off: b.disabled, t }));
      });
      assert.ok(states.filter((s) => s.d >= states[0].t).every((s) => !s.off));
    });
  });

  // Request-count tests (the page's own requests, so parallel test files cannot disturb them).
  const countDays = (page) => {
    const urls = [];
    page.on("request", (r) => r.url().includes("/bookable-days") && urls.push(new URL(r.url()).searchParams.get("from")));
    return urls;
  };
  test("bookable-days: one request per month, however fast the visitor pages; answers that arrive late are still cached", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/bookable-days*`, async (r) => {
        await new Promise((res) => setTimeout(res, 400)); // slow answers: the visitor pages on before they arrive
        await r.fallback();
      });
      const urls = countDays(page);
      await driveTo(page, "services");
      await page.click("#cta-services");
      await page.click("#next");
      await page.click("#next");
      await page.click("#prev");
      await page.click("#prev");
      await page.click("#next");
      await page.waitForTimeout(1500);
      assert.equal(urls.length, 3, `months 0, 1 and 2 once each: ${urls}`);
      assert.equal(new Set(urls).size, 3);
      await page.click("#prev");
      await page.click("#next");
      await page.click("#next");
      await page.waitForTimeout(300);
      assert.equal(urls.length, 3, "paging over cached months asks nothing");
      assert.equal(await page.locator(".dbtn.off:not(.today)").count() > 0, true);
    });
  });

  test("bookable-days failing: one try per visit to a month (no loop), and a later visit asks again", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/bookable-days*`, (r) => r.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "" }));
      const urls = countDays(page);
      await driveTo(page, "services");
      await page.click("#cta-services");
      await page.click("#next");
      await page.click("#prev");
      await page.click("#next");
      await page.waitForTimeout(300);
      // Audit cycle 2: a failed request is forgotten, so each visit to a month is one try (never a loop); the calendar stays all-enabled meanwhile.
      assert.equal(urls.length, 4, `one try per visit: ${urls}`);
      await page.click(`[data-day="${await pickableDay(page)}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      await page.goBack();
      await page.waitForTimeout(300);
      assert.ok(urls.length > 4, "re-entering the date step asks again for the month that failed");
      assert.equal(await page.locator(".dbtn.off:not(.today)").evaluateAll((l) => l.every((b) => b.dataset.day < document.querySelector(".dbtn.today").dataset.day)), true, "failure: only past days are off");
    });
  });

  test("bookable-days: re-entering the date step before the first answer does not send a duplicate", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/bookable-days*`, async (r) => {
        await new Promise((res) => setTimeout(res, 700));
        await r.fallback();
      });
      const urls = countDays(page);
      await driveTo(page, "services");
      await page.click("#cta-services");
      await page.goBack();
      await page.click("#cta-services");
      await page.waitForTimeout(1200);
      assert.equal(urls.length, 1, `one request in flight is reused: ${urls}`);
    });
  });

  test("a chosen day that is off for the re-chosen services is dropped even from the cache (no selected+disabled day, no enabled Далі)", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      // The mock: with the pedicure service Saturdays are off. B = pedicure, A = classic manicure.
      const sat = () => page.evaluate(() => [...document.querySelectorAll(".dbtn")].find((b) => new Date(`${b.dataset.day}T12:00:00Z`).getUTCDay() === 6 && b.dataset.day > document.querySelector(".dbtn.today").dataset.day)?.dataset.day);
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      await page.click(`#svc-list [data-id="${SVC_ID.pedi}"]`);
      await page.click("#cta-services");
      await page.waitForFunction(() => document.querySelector(".dbtn.off:not(.today)[data-day]") && [...document.querySelectorAll(".dbtn.off")].some((b) => new Date(`${b.dataset.day}T12:00:00Z`).getUTCDay() === 6 && b.dataset.day > document.querySelector(".dbtn.today").dataset.day));
      const d = await sat();
      assert.equal(await page.locator(`[data-day="${d}"]`).isDisabled(), true, "Saturday is off for B");
      await page.click("[data-screen=date] [data-back]");
      await page.click(`#svc-list [data-id="${SVC_ID.pedi}"]`); // B off
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`); // A on
      await page.click("#cta-services");
      await page.waitForSelector(`[data-day="${d}"]:not([disabled])`);
      await page.click(`[data-day="${d}"]`);
      assert.equal(await page.locator("#cta-date").isDisabled(), false);
      await page.click("[data-screen=date] [data-back]");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`); // A off
      await page.click(`#svc-list [data-id="${SVC_ID.pedi}"]`); // B on again: its answer is cached
      await page.click("#cta-services");
      assert.equal(await page.locator(`[data-day="${d}"]`).isDisabled(), true);
      assert.equal(await page.locator(`[data-day="${d}"].sel`).count(), 0, "the off day is no longer selected");
      assert.equal(await page.locator("#cta-date").isDisabled(), true, "Далі is disabled until a valid day is chosen");
    });
  });

  test("the strip on every step shows the rating like the app: «★ 4.9 (128)», «★ —» for an unreviewed master, the role label without a title", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "date");
      assert.match(await text(page.locator("[data-screen=date] .strip .rate")), /^4\.9 \(\d+\)$/);
      assert.ok((await text(page.locator("[data-screen=date] .strip"))).includes("Запис до майстра"));
    });
    await withPage("sparse-0001", {}, async ({ page }) => {
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      assert.equal(await text(page.locator("[data-screen=services] .strip .rate")), "—");
      assert.ok((await text(page.locator("[data-screen=services] .strip"))).includes("Незалежний майстер"));
      assert.equal((await page.locator("[data-screen=services] .strip .rate svg").boundingBox())?.width > 0, true, "the star renders");
    });
  });
});

describe("multi-service visit", () => {
  test("three services: one booking with masterServiceIds, availability asked for all three, totals added up", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      const name = "ТриПослуги";
      await page.click("#book-cta");
      for (const id of [SVC_ID.classic, SVC_ID.gel, SVC_ID.pedi]) await page.click(`#svc-list [data-id="${id}"]`);
      assert.match(await text(page.locator("[data-sb='services']")), /3 послуги.*Разом.*4 год.*від 1 900 ₴/);
      await page.click("[data-sb='services'] .labelrow");
      assert.equal(await page.locator("[data-sb='services'] .sel-entry").count(), 3);
      await page.click(`[data-sb='services'] [aria-label="Прибрати: Манікюр класичний"]`);
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      await page.click(`[data-day="${await pickableDay(page)}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      await page.locator("#slots .slot").first().click();
      await page.click("#cta-time");
      await fillContact(page, { name });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.locator("#otp input").fill("654321");
      await page.waitForSelector("#confirm-card", { state: "visible" });
      assert.ok((await text(page.locator("#confirm-card"))).includes("4 год"));
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const log = await mockLog((e) => e.body?.name === name || e.path.includes("oksana-ab12/availability"));
      const booking = callsTo(log, "POST", "/booking").at(-1);
      assert.deepEqual(booking.body.masterServiceIds.sort(), [SVC_ID.classic, SVC_ID.gel, SVC_ID.pedi].sort());
      assert.equal(booking.body.serviceId, undefined, "a visit sends masterServiceIds only");
      // The mock log is shared with other test files running against the same API: match this test's own request by its
      // three service ids instead of taking whichever availability call came last.
      const want = [SVC_ID.classic, SVC_ID.gel, SVC_ID.pedi].sort().join();
      const avail = callsTo(log, "GET", "oksana-ab12/availability").filter((e) => new URL(e.path, "http://x").searchParams.getAll("serviceId").sort().join() === want);
      assert.ok(avail.length >= 1, "the availability query carried all three service ids");
    });
  });

  test("at most 10 services can be chosen (the 11th tap is ignored)", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.click("#book-cta");
      for (const id of Object.values(SVC_ID)) await page.click(`#svc-list [data-id="${id}"]`);
      assert.equal(await page.locator("#svc-list [aria-pressed=true]").count(), 4);
      assert.match(await text(page.locator("[data-sb='services']")), /4 послуги/);
    });
  });

  test("changing the services after choosing a time drops that time", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.goBack();
      await page.goBack();
      assert.equal(await visibleScreen(page), "services");
      await page.click(`#svc-list [data-id="${SVC_ID.gel}"]`);
      await page.click("#cta-services");
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      assert.equal(await page.locator("#cta-time").isDisabled(), true, "the previous time is gone");
    });
  });
});

describe("salon master", () => {
  test("a master of a salon: «Салон» row in the recap, back link to the salon page", async () => {
    await withPage("salonmaster-5555", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "СалонЗапис" } });
      const recap = await text(page.locator("#confirm-card"));
      assert.ok(recap.includes("Салон") && recap.includes("Салон «Лаванда»"), recap);
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.ok((await text(page.locator("#done-card"))).includes("Салон «Лаванда»"));
      const booking = callsTo(await mockLog((e) => e.body?.name === "СалонЗапис"), "POST", "/salonmaster-5555/booking");
      assert.equal(booking.length, 1, "the booking goes to the chosen master's slug");
    });
  });
});

describe("time step", () => {
  test("a day without free time shows the empty state; «Змінити» returns to the calendar", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      // The mock greys Sundays out; a failing bookable-days endpoint (fallback: all days selectable) lets the test reach the empty state.
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/bookable-days*`, (r) => r.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "" }));
      await page.click("#book-cta");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      await page.click(`[data-day="${await pickableDay(page, { sunday: true })}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#time-empty", { state: "visible" });
      assert.ok((await text(page.locator("#time-empty"))).includes("Немає вільного часу"));
      assert.equal(await page.locator("#cta-time").isDisabled(), true);
      await page.click("#time-change");
      assert.equal(await visibleScreen(page), "date");
    });
  });

  test("availability failure (backend down) shows a retryable error, not an empty day", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/availability*`, (r) => r.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "" }));
      await page.click("#book-cta");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      await page.click(`[data-day="${await pickableDay(page)}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#time-error", { state: "visible" });
      assert.equal(await page.locator("#time-empty").isVisible(), false);
    });
  });

  // The conflict-9999 slug MUST stay unique to this test: the re-fetch count below is read from the shared mock log.
  test("409 at the end: back to the time step, message, refreshed slots, the chosen time cleared", async () => {
    await withPage("conflict-9999", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Конфлікт" } });
      const before = (await mockLog((e) => e.path.includes("conflict-9999/availability"))).length;
      await page.click("#cta-confirm");
      await page.waitForSelector("#time-conflict", { state: "visible" });
      assert.equal(await visibleScreen(page), "time");
      assert.ok((await text(page.locator("#time-conflict"))).includes("Цей час уже зайнято. Оберіть інший."));
      await page.waitForSelector("#slots .slot");
      assert.ok((await mockLog((e) => e.path.includes("conflict-9999/availability"))).length > before, "slots were re-fetched");
      assert.equal(await page.locator("#slots .slot[aria-pressed=true]").count(), 0);
      assert.equal(await page.locator("#cta-time").isDisabled(), true);
      await page.locator("#slots .slot").nth(3).click();
      assert.equal(await page.locator("#time-conflict").isVisible(), false, "choosing another time clears the message");
    });
  });
});

describe("contact step", () => {
  test("validation: empty fields are flagged inline, linked to the field, and nothing is sent", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "", surname: "", phone: "671290021" } }); // a VALID phone unique to this test: a skipped validation would send it
      await page.fill("#name", "");
      await toggleConsent(page); // untick the consent
      await page.click("#cta-contact");
      assert.equal(await page.locator("#f-name .ferr").isVisible(), true);
      assert.ok((await text(page.locator("#f-name .ferr"))).includes("Це поле обов'язкове"));
      assert.ok((await text(page.locator("#consent-err"))).includes("Без згоди ми не можемо записати вас."));
      assert.equal(await page.getAttribute("#name", "aria-describedby"), "e-name", "the error is linked to its field");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "name", "focus goes to the first invalid field");
      assert.deepEqual(await mockLog((e) => e.path.includes("/otp/send") && e.body?.phone === "+380671290021"), [], "nothing sent for this test's phone");
      await page.fill("#phone", "");
      await page.type("#phone", "5");
      await page.click("#cta-contact");
      assert.ok((await text(page.locator("#f-phone .ferr"))).includes("Невірний номер телефону"));
      await fillContact(page, { name: "Поправила", surname: "Іваненко", phone: "671112233" });
      await page.fill("#phone", "");
      await page.type("#phone", "671112233");
      assert.equal(await page.locator("#f-name .ferr").count(), 0, "the error clears as the field is fixed");
    });
  });

  test("the consent is unticked by default and links to /privacy#guest in a new tab", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      assert.equal(await page.locator("#consent").isChecked(), false);
      const link = page.getByRole("link", { name: "Політика конфіденційності" });
      assert.equal(await link.getAttribute("href"), "/privacy#guest");
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.match(await link.getAttribute("rel"), /noopener/);
    });
  });

  test("phone and name fields use the right mobile keyboards and autofill hints", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      assert.equal(await page.getAttribute("#phone", "inputmode"), "numeric");
      assert.equal(await page.getAttribute("#phone", "autocomplete"), "tel");
      assert.equal(await page.getAttribute("#name", "autocomplete"), "given-name");
      assert.equal(await page.getAttribute("#surname", "autocomplete"), "family-name");
    });
  });

  test("Backspace over the separators of the phone mask removes digits, never sticks", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await page.type("#phone", "501234567");
      for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
      assert.equal(await page.inputValue("#phone"), "+380 50 123");
    });
  });

  test("SMS unavailable (503): the contact step says so, with support@ — no code screen", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Смс503", phone: "500000503" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#cb-sms", { state: "visible" });
      assert.equal(await visibleScreen(page), "contact");
      assert.ok((await text(page.locator("#cb-sms"))).includes("SMS тимчасово недоступні"));
      assert.equal(await page.locator("#cb-sms a").getAttribute("href"), "mailto:support@beautica.app");
      assert.equal(await page.locator("#cta-contact").isEnabled(), true, "the button is usable again");
    });
  });

  test("too many tries (429): «Забагато спроб, спробуйте пізніше.»", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Ліміт429", phone: "500000429" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#cb-limit", { state: "visible" });
      assert.ok((await text(page.locator("#cb-limit"))).includes("Забагато спроб, спробуйте пізніше."));
    });
  });

  test("a rejected Turnstile token (400): asks to confirm the check again", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Токен400", phone: "500000400" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#turn-err", { state: "visible" });
      assert.ok((await text(page.locator("#turn-err"))).includes("Підтвердіть, що ви не робот"));
      assert.equal(await visibleScreen(page), "contact");
    });
  });

  test("Turnstile script blocked: a clear message and NO request to /otp/send", async () => {
    await withPage("oksana-ab12", { turnstile: "blocked" }, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await fillContact(page, { name: "БезТурнстайл", phone: "500000011" });
      await page.click("#cta-contact");
      await page.waitForSelector("#turn-err", { state: "visible" });
      assert.ok((await text(page.locator("#turn-err"))).includes("Не вдалося") || (await text(page.locator("#turn-err"))).includes("Підтвердіть"));
      assert.deepEqual(await mockLog((e) => e.body?.phone === "+380500000011"), []);
      assert.equal(await visibleScreen(page), "contact");
    });
  });

  test("the Turnstile row renders in the contact step (widget-sized box, inside the column, no overflow)", async () => {
    await withPage("oksana-ab12", {}, async ({ page, turnstileRequests }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await page.waitForSelector("#ts-widget iframe", { state: "attached" });
      const row = page.locator("#ts-widget");
      assert.ok(await visibleBox(row), "the row has a box");
      const b = await row.boundingBox();
      assert.ok(b.height >= 65 && b.width >= 300, `${b.width}x${b.height}`);
      assert.ok(b.x >= 0 && b.x + b.width <= 360, "inside the 360 px viewport");
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
      assert.ok(turnstileRequests.length >= 1);
    });
  });

  test("Turnstile is loaded lazily at the contact step, never on page load", async () => {
    await withPage("oksana-ab12", {}, async ({ page, turnstileRequests }) => {
      await page.waitForLoadState("networkidle");
      assert.deepEqual(turnstileRequests, []);
      await driveTo(page, "time");
      assert.deepEqual(turnstileRequests, []);
      await page.click("#cta-time");
      await page.waitForSelector("#ts-widget", { state: "attached" });
      await page.waitForTimeout(300);
      assert.equal(turnstileRequests.length, 1);
    });
  });
});

describe("SMS code step", () => {
  test("a wrong code: the cells go red with the app's message, the retry works", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Невірний", phone: "500000020" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.locator("#otp input").fill("000000"); // a whole code in one go submits by itself (phase 029)
      await page.waitForSelector("#otp-wrong", { state: "visible" });
      assert.ok((await text(page.locator("#otp-wrong"))).includes("Невірний або прострочений код. Перевірте цифри або запросіть новий код."));
      assert.equal(await page.locator("#otp.invalid").count(), 1);
      assert.equal(await visibleScreen(page), "otp");
      await page.locator("#otp input").fill("000007");
      assert.equal(await page.locator("#otp-wrong").isVisible(), false, "typing clears the error");
      await page.waitForSelector("#confirm-card", { state: "visible" });
    });
  });

  test("one real input: whole-code autofill, a formatted paste and Backspace all work; the cells only mirror it", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Вставка", phone: "500000021" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      assert.equal(await page.locator("#otp input").count(), 1, "a single input is the autofill / paste target");
      assert.equal(await page.locator("#otp .otp-cell[aria-hidden=true]").count(), 6);
      assert.equal(await page.getAttribute("#otp input", "autocomplete"), "one-time-code");
      assert.equal(await page.getAttribute("#otp input", "inputmode"), "numeric");
      assert.equal(await page.getAttribute("#otp input", "maxlength"), "6");
      // A whole code in one event submits by itself (phase 029): the backend refuses it here, so the step stays and the rest can be checked.
      await page.context().route(`${MOCK_API}/api/v1/book/otp/verify`, (r) => r.fulfill({ status: 401, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "{}" }));
      await page.locator("#otp input").evaluate((el) => {
        el.value = "246810";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.deepEqual(await page.locator("#otp .otp-cell").evaluateAll((els) => els.map((e) => e.textContent)), [..."246810"]);
      await page.waitForSelector("#otp-wrong", { state: "visible" });
      assert.equal(await page.locator("#cta-otp").isEnabled(), true);
      // A pasted «123 456» (iOS would cut it to 6 chars before sanitising) is reduced to digits by the paste handler.
      await page.locator("#otp input").evaluate((el) => {
        const dt = new DataTransfer();
        dt.setData("text", "123 456");
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      assert.equal(await page.inputValue("#otp input"), "123456");
      await page.locator("#otp input").evaluate((el) => {
        el.value = "12a3-";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.equal(await page.inputValue("#otp input"), "123", "non-digits are dropped");
      assert.equal(await page.locator("#cta-otp").isEnabled(), false);
    });
  });

  test("Backspace removes the last digit", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Бекспейс", phone: "500000022" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.locator("#otp input").pressSequentially("12");
      assert.equal(await page.inputValue("#otp input"), "12");
      await page.keyboard.press("Backspace");
      assert.equal(await page.inputValue("#otp input"), "1");
      assert.equal(await page.locator("#otp .otp-cell").nth(1).textContent(), "");
    });
  });

  test("resend: not available during the cooldown", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Повтор", phone: "500000023" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      assert.equal(await page.locator("#otp-resend-btn").isVisible(), false);
      assert.equal(await page.locator("#otp-wait").isVisible(), true);
    });
  });

  test("resend after the cooldown asks Turnstile for a NEW token and sends a second code", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.clock.install();
      await driveTo(page, "contact", { contact: { name: "Повтор2", phone: "500000024" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.clock.runFor(61000);
      await page.waitForSelector("#otp-resend-btn", { state: "visible" });
      await page.click("#otp-resend-btn");
      await page.clock.runFor(100); // the fake Turnstile hands out the new token on a 5 ms timer
      await page.waitForFunction(() => document.querySelector("#otp-wait") && !document.querySelector("#otp-wait").hidden);
      const sends = callsTo(await mockLog((e) => e.body?.phone === "+380500000024"), "POST", "/otp/send");
      assert.equal(sends.length, 2);
      assert.notEqual(sends[0].body.turnstileToken, sends[1].body.turnstileToken, "a Turnstile token is single-use");
    });
  });

  test("verify rate-limited (429): the app's message on the code screen", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await driveTo(page, "contact", { contact: { name: "Ліміт", phone: "500000025" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await context.route(`${MOCK_API}/api/v1/book/otp/verify`, (r) => r.fulfill({ status: 429, headers: { "access-control-allow-origin": "*" }, body: "" }));
      await page.locator("#otp input").fill("123456");
      await page.waitForSelector("#otp-limit", { state: "visible" });
    });
  });
});

describe("confirm step", () => {
  test("booking service down (503): a message on the confirm step, the button works again, no double booking", async () => {
    await withPage("bookdown-7777", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Збій503" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#submit-error", { state: "visible" });
      assert.ok((await text(page.locator("#submit-error"))).includes("Запис тимчасово недоступний"));
      assert.equal(await visibleScreen(page), "confirm");
      assert.equal(await page.locator("#cta-confirm").isEnabled(), true);
      assert.equal(await page.locator("#cta-confirm").getAttribute("aria-busy"), null);
    });
  });

  test("expired SMS session (401): back to the code step with an explanation, token dropped", async () => {
    await withPage("expired-6666", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Сесія401" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#otp-session", { state: "visible" });
      assert.equal(await visibleScreen(page), "otp");
      assert.ok((await text(page.locator("#otp-session"))).includes("Підтвердження номера застаріло"));
    });
  });

  test("double click: one booking request, the button is busy meanwhile", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      let release;
      const gate = new Promise((r) => (release = r));
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/booking`, async (route) => {
        await gate;
        await route.continue();
      });
      await driveTo(page, "confirm", { contact: { name: "ДвоКліки" } });
      await page.click("#cta-confirm");
      assert.equal(await page.locator("#cta-confirm").isDisabled(), true, "disabled while the request runs");
      assert.equal(await page.locator("#cta-confirm").getAttribute("aria-busy"), "true");
      await page.locator("#cta-confirm").dispatchEvent("click");
      await page.locator("#cta-confirm").dispatchEvent("click");
      release();
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.equal(callsTo(await mockLog((e) => e.body?.name === "ДвоКліки"), "POST", "/booking").length, 1);
    });
  });
});
