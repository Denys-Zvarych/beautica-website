// Phase 012: /book app-parity fixes that the flow/pages specs do not reach: a bookable-days answer that changes the picture mid-session,
// the role chip / strip fallbacks for a salon master without a title, and the 48 px day targets at 320 px.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { MOCK_API } from "./helpers/env.mjs";
import { bookPage, driveTo, SVC_ID } from "./helpers/book.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());
const noProblems = (env) => assert.deepEqual(env.problems, [], "no console / page errors");

describe("bookable-days answer that changes mid-session", () => {
  test("a late answer that turns the selected day off clears it and disables «Далі» (the day stays disabled, nothing selected)", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page, context } = env;
      let release;
      const gate = new Promise((r) => (release = r));
      let n = 0;
      let day;
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/bookable-days*`, async (route) => {
        if (++n === 1) return route.fallback(); // month 0: the honest answer
        const res = await route.fetch();
        const body = await res.json();
        await gate; // month 1 answers only when the test says so, after the visitor has paged back
        // The stale/odd answer also covers the chosen day (month 0) and says it is not working.
        await route.fulfill({ response: res, json: [...body, { date: day, working: false }] });
      });
      await driveTo(page, "date");
      day = await page.evaluate(() => document.querySelector(".dbtn.sel").dataset.day);
      assert.equal(await page.locator("#cta-date").isDisabled(), false, "a working day is chosen: Далі is enabled");
      await page.click("#next");
      await page.click("#prev");
      assert.equal(await page.locator(`[data-day="${day}"].sel`).count(), 1, "back on month 0 the day is still selected before the answer");
      release();
      await page.waitForFunction(() => document.querySelector("#cta-date").disabled);
      assert.equal(await page.locator(".dbtn.sel").count(), 0);
      assert.equal(await page.locator(`[data-day="${day}"]`).isDisabled(), true);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("role chip and strip fallbacks", () => {
  test("a salon master without a title: the profile chip reads «Майстер салону» and so does the booking strip", async () => {
    const env = await bookPage(browser, "salonnotitle-5656");
    try {
      assert.equal(await text(env.page.locator(".rolechip")), "Майстер салону");
      await env.page.click("#book-cta");
      await env.page.waitForSelector("[data-screen=services]:not([hidden])");
      assert.match(await text(env.page.locator("[data-screen=services] .strip")), /Запис до майстра.*Майстер салону/);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("an unreviewed master: the strip on the services AND the date step show exactly «★ —» (no count) with a rendered star", async () => {
    const env = await bookPage(browser, "sparse-0001");
    try {
      const { page } = env;
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      for (const step of ["services", "date"]) {
        if (step === "date") await page.click("#cta-services");
        const rate = page.locator(`[data-screen=${step}] .strip .rate`);
        assert.equal(await text(rate), "—", `${step}: no number, no «(0)»`);
        const box = await rate.locator("svg").boundingBox();
        assert.ok(box && box.width > 0 && box.height > 0, `${step}: star has a box`);
      }
      assert.match(await text(page.locator("[data-screen=date] .strip")), /Незалежний майстер/);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("calendar at 320 px", () => {
  test("every day button is at least 48 px wide and tall; the date step does not scroll sideways", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 320, height: 700 });
    try {
      const { page } = env;
      await driveTo(page, "services");
      await page.click("#cta-services");
      await page.waitForSelector(".dbtn");
      const m = await page.evaluate(() => {
        const sizes = [...document.querySelectorAll(".dbtn")].map((b) => b.getBoundingClientRect()).map((r) => [r.width, r.height]);
        return { minW: Math.min(...sizes.map((s) => s[0])), minH: Math.min(...sizes.map((s) => s[1])), n: sizes.length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      assert.ok(m.n >= 28, "a month of days");
      assert.ok(m.minW >= 47.99, `day buttons ${m.minW}px wide`);
      assert.ok(m.minH >= 47.99, `day buttons ${m.minH}px tall`);
      assert.equal(m.over, 0, "no horizontal scroll");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});
