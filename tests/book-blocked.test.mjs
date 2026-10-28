// Phase 020: a blocked guest phone. The booking POST answers 409 data.code=BOOKING_UNAVAILABLE (backend 398): a neutral banner, no slot
// reload, no retry hint. Any other 409 keeps the slot-conflict flow (covered by booking-flow / book-salon-wizard tests: conflict-9999, wiz-c409).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { requireBase } from "./helpers/env.mjs";
import { bookPage, callsTo, driveTo, mockLog } from "./helpers/book.mjs";
import { S2, M1, salonPage, pickServices, toggleMaster, clickAndLoadDays, scheduleMaster, verifyOtp } from "./helpers/salon.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());
const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());
const quiet = (env) => assert.deepEqual(env.problems.filter((p) => !/status of (409|401)/.test(p)), [], "no console / page errors");

describe("020: BOOKING_UNAVAILABLE", () => {
  test("master link: the neutral banner on the confirm step; no slot reload, no conflict message, a visible box", async () => {
    const env = await bookPage(browser, "blocked-4098");
    try {
      const { page } = env;
      await driveTo(page, "confirm", { contact: { name: "Заблокована", phone: "501290098" } });
      const before = (await mockLog((e) => e.path.includes("blocked-4098/availability"))).length;
      await page.click("#cta-confirm");
      await page.waitForSelector("#submit-error", { state: "visible" });
      assert.equal(await text(page.locator("#submit-error-text")), "Запис до цього майстра зараз недоступний");
      const box = await page.locator("#submit-error").boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0);
      assert.equal(await page.locator("[data-screen=confirm]").isVisible(), true, "stays on the confirm step");
      assert.equal(await page.locator("#time-conflict").isVisible(), false);
      assert.equal((await mockLog((e) => e.path.includes("blocked-4098/availability"))).length, before, "slots are not re-fetched");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("salon link: the salon wording on the master's card, without the «не створено» prefix; the form is not reset", async () => {
    const env = await salonPage(browser, "wiz-blk-0001");
    try {
      const { page } = env;
      await pickServices(page, S2);
      await page.click("#cta-services");
      await toggleMaster(page, M1);
      await clickAndLoadDays(page, "#cta-masters");
      await scheduleMaster(page, 1);
      await page.click("#cta-time");
      await verifyOtp(page, "501290099");
      await page.click("#cta-confirm");
      const card = page.locator("#salon-cards [data-appt]").first();
      await card.locator("[data-appt-error]:not([hidden])").waitFor();
      assert.equal(await text(card.locator("[data-appt-error]")), "Запис до цього салону зараз недоступний");
      assert.equal(await card.locator("[data-appt-change]").isHidden(), true, "no «Змінити час» for a block");
      assert.equal(await page.locator("[data-screen=confirm]").isVisible(), true);
      assert.equal(callsTo(await mockLog(), "POST", "/book/s/wiz-blk-0001/masters/").length, 1);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
});
