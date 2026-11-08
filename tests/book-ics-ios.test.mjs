// Phase 025: «Додати в календар» is the SAME plain link on every platform (iOS Safari opens Calendar's «Add event» sheet only for a text/calendar
// file fetched from a real https URL; blobs / data: / the share sheet are gone). So on iPhone, iPadOS and desktop the done screen must hold
// <a href="/api/ics?..."> and no script may intercept it (no share API call, no blob URL, no data: navigation).
// Plus the OTP step is ONE autofill target (autocomplete=one-time-code, maxlength=6) whose cells mirror a whole-code single input event.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { uk } from "./helpers/env.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipados: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** Init script: records every share / canShare / blob / data: navigation attempt, so "none happened" is a real assertion. */
const spies = `(${() => {
  window.__ics = { shareCalls: 0, blobs: 0, dataNavs: 0 };
  navigator.share = () => (window.__ics.shareCalls++, Promise.resolve());
  navigator.canShare = () => (window.__ics.shareCalls++, true);
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => (window.__ics.blobs++, create(b));
  window.navigation?.addEventListener("navigate", (e) => e.destination.url.startsWith("data:") && window.__ics.dataNavs++);
}})()`;

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

/** Books through the real flow up to the success screen and reads the calendar control. */
async function doneScreen(ua) {
  const env = await bookPage(browser, "oksana-ab12", { userAgent: ua, hasTouch: ua !== UA.desktop, init: spies });
  try {
    await driveTo(env.page, "confirm", { contact: { name: "Айос", phone: "500000031" } });
    await env.page.click("#cta-confirm");
    await env.page.waitForSelector("#done-card", { state: "visible" });
    const control = env.page.getByRole("link", { name: uk.book.done.calendarApple });
    const tag = await control.evaluate((e) => e.tagName);
    const href = await control.getAttribute("href");
    // Intercept but pass the REAL endpoint response through (inline text/calendar opens the iOS Calendar sheet and keeps the page where it is), and assert its real header so a regression to `attachment` goes red; then look at what the click ran.
    let real;
    await env.page.route("**/api/ics?**", async (r) => {
      const res = await r.fetch();
      real = { status: res.status(), type: res.headers()["content-type"], disposition: res.headers()["content-disposition"] };
      await r.fulfill({ response: res });
    });
    const [download] = await Promise.all([env.page.waitForEvent("download"), control.click()]);
    assert.equal(real?.status, 200);
    assert.match(real.type, /^text\/calendar/);
    assert.match(real.disposition, /^inline/, "real /api/ics must answer content-disposition: inline");
    assert.equal(download.suggestedFilename(), "beautica-booking.ics");
    const spy = await env.page.evaluate(() => window.__ics);
    return { tag, href, spy, buttons: await env.page.getByRole("button", { name: new RegExp(`${uk.book.done.calendarGoogle}|${uk.book.done.calendarApple}`) }).count() };
  } finally {
    await env.context.close();
  }
}

describe("add to calendar is a plain link to /api/ics on every platform", () => {
  for (const [name, ua] of Object.entries(UA))
    test(`${name}: <a href="/api/ics?..."> and no share sheet, blob or data: navigation`, async () => {
      const r = await doneScreen(ua);
      assert.equal(r.tag, "A");
      assert.match(r.href, /^\/api\/ics\?s=\d{4}-\d\d-\d\dT\d\d%3A\d\d%3A\d\dZ&e=/);
      assert.equal(r.buttons, 0, "not a <button>");
      assert.deepEqual(r.spy, { shareCalls: 0, blobs: 0, dataNavs: 0 });
    });
});

describe("OTP step is a single iOS-autofill target", () => {
  test("one input[autocomplete=one-time-code][maxlength=6]; a whole 6-digit code in ONE input event fills all cells and enables the CTA", async () => {
    const env = await bookPage(browser, "oksana-ab12", { userAgent: UA.iphone, hasTouch: true });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Автозаповнення", phone: "500000033" } });
      await env.page.click("#cta-contact");
      await env.page.waitForSelector("#otp", { state: "visible" });
      const field = env.page.locator("#otp input");
      assert.equal(await field.count(), 1, "exactly one input in the OTP block (old markup had six)");
      assert.equal(await field.getAttribute("autocomplete"), "one-time-code");
      assert.equal(await field.getAttribute("maxlength"), "6");
      assert.equal(await env.page.locator("#cta-otp").isDisabled(), true, "disabled before the code");
      await field.evaluate((el) => {
        el.value = "482915"; // what iOS QuickType autofill does: the entire code, one event
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.deepEqual(await env.page.locator("#otp .otp-cell").evaluateAll((els) => els.map((e) => e.textContent)), [..."482915"]);
      // The whole code in one event submits by itself (phase 029): the confirm step follows with no tap.
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.deepEqual(env.problems, []);
    } finally {
      await env.context.close();
    }
  });
});
