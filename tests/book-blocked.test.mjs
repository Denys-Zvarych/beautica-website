// Phase 020: a blocked guest phone. The booking POST answers 409 data.code=BOOKING_UNAVAILABLE (backend 398): a neutral banner, no slot
// reload, no retry hint. Any other 409 keeps the slot-conflict flow (covered by booking-flow / book-salon-wizard tests: conflict-9999, wiz-c409).
import { test, describe, before, after } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { requireBase } from "./helpers/env.mjs";
import { bookPage, callsTo, driveTo, mockLog } from "./helpers/book.mjs";
import { S2, M1, salonPage, pickServices, toggleMaster, clickAndLoadDays, scheduleMaster, verifyOtp } from "./helpers/salon.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const REVEALS = /заблок|блок|block|ban|чорн|обмеж|заборон/i; // nothing in the banner may hint that a block exists
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

  test("master link: the banner never reveals a block (no block wording, no server text, no action, no link)", async () => {
    const env = await bookPage(browser, "blocked-4097");
    try {
      const { page } = env;
      await driveTo(page, "confirm", { contact: { name: "Інна", phone: "501290097" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#submit-error", { state: "visible" });
      const shown = await text(page.locator("#submit-error"));
      assert.equal(shown, "Запис до цього майстра зараз недоступний");
      assert.doesNotMatch(shown, REVEALS);
      assert.doesNotMatch(shown, /Booking is not available/, "the server message is never rendered");
      assert.equal(await page.locator("#submit-error a, #submit-error button").count(), 0, "no retry / contact action inside the banner");
      assert.equal(await page.locator("#submit-error").getAttribute("role"), "alert", "announced to assistive tech");
      assert.doesNotMatch(await text(page.locator("[data-screen=confirm]")), REVEALS, "nothing else on the step hints at a block either");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("master link: after the banner the form keeps its state, nothing is re-sent but the booking, a second try shows the same banner", async () => {
    const env = await bookPage(browser, "blocked-4097");
    try {
      const { page } = env;
      await driveTo(page, "confirm", { contact: { name: "Марина", phone: "501290096" } });
      const mark = (await mockLog()).length;
      await page.click("#cta-confirm");
      await page.waitForSelector("#submit-error", { state: "visible" });
      assert.equal(await page.locator("#cta-confirm").isEnabled(), true, "the button is released");
      assert.equal(await page.locator("#confirm-card").isVisible(), true, "the summary stays");
      assert.equal(await page.locator("#name").inputValue(), "Марина");
      assert.equal(await page.locator("#surname").inputValue(), "Коваленко");
      assert.equal((await page.locator("#phone").inputValue()).replace(/\D/g, ""), "380501290096");
      await page.click("#cta-confirm");
      await page.waitForFunction(() => document.querySelectorAll("#submit-error:not([hidden])").length === 1);
      assert.equal(await text(page.locator("#submit-error-text")), "Запис до цього майстра зараз недоступний");
      const after = (await mockLog()).slice(mark).filter((e) => e.path.startsWith("/api/v1/book/"));
      assert.deepEqual(after.map((e) => `${e.method} ${e.path.split("blocked-4097")[1] ?? e.path}`), ["POST /booking", "POST /booking"], "no OTP send / verify, no availability reload");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("master link: a 409 with ANOTHER data.code stays the slot conflict (no blocked banner)", async () => {
    const env = await bookPage(browser, "conflictcode-4096");
    try {
      const { page } = env;
      await driveTo(page, "confirm", { contact: { phone: "501290095" } });
      await page.click("#cta-confirm");
      await page.locator("#time-conflict").waitFor({ state: "visible" });
      assert.equal(await page.locator("#submit-error").isVisible(), false);
      assert.doesNotMatch(await text(page.locator("body")), /зараз недоступний/);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("OTP verify: 409 BOOKING_UNAVAILABLE is not mapped (the code is booking-create only): the generic code error, never the blocked wording", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      await driveTo(page, "otp", { contact: { phone: "500000409" } });
      await page.click("#cta-otp");
      await page.locator("#otp-error").waitFor({ state: "visible" });
      assert.doesNotMatch(await text(page.locator("body")), /зараз недоступний/);
      assert.equal(await page.locator("[data-screen=otp]").isVisible(), true, "stays on the code step");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("master link: axe is clean with the banner shown (360 px)", async () => {
    const env = await bookPage(browser, "blocked-4097");
    try {
      const { page } = env;
      await driveTo(page, "confirm", { contact: { phone: "501290094" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#submit-error", { state: "visible" });
      await page.waitForTimeout(350); // animations settle: axe reads the live colours
      await page.evaluate(AXE);
      const r = await page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }));
      assert.deepEqual(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`), []);
    } finally {
      await env.context.close();
    }
  });

  test("salon link: the banner never reveals a block, axe is clean on the card error (360 px), and the SALON text is never the master one", async () => {
    const env = await salonPage(browser, "wiz-blk-0002");
    try {
      const { page } = env;
      await pickServices(page, S2);
      await page.click("#cta-services");
      await toggleMaster(page, M1);
      await clickAndLoadDays(page, "#cta-masters");
      await scheduleMaster(page, 1);
      await page.click("#cta-time");
      await verifyOtp(page, "501290093");
      await page.click("#cta-confirm");
      const err = page.locator("#salon-cards [data-appt-error]:not([hidden])").first();
      await err.waitFor();
      const shown = await text(err);
      assert.equal(shown, "Запис до цього салону зараз недоступний");
      assert.doesNotMatch(shown, REVEALS);
      assert.doesNotMatch(shown, /майстра/, "salon wording, not the master one");
      assert.doesNotMatch(shown, /не створено/, "no «not created» prefix (it would imply a per-master reason)");
      await page.waitForTimeout(350);
      await page.evaluate(AXE);
      const r = await page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }));
      assert.deepEqual(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`), []);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
});
