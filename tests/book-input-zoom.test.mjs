// Mobile browsers (iOS Safari, some Android) zoom the page when a text control with a computed font-size under 16px gets focus.
// Every text input, textarea and select of the booking link pages must compute to >= 16px, and the viewport must stay zoomable (a11y).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";
import { salonPage, toConfirm } from "./helpers/salon.mjs";
import { requireBase } from "./helpers/env.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const sizes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")]
      .filter((el) => !["checkbox", "radio", "hidden", "submit", "button"].includes(el.type))
      .map((el) => ({ id: el.id || el.name || el.className || el.tagName, px: parseFloat(getComputedStyle(el).fontSize) })),
  );

describe("booking flow: no focus zoom on mobile", () => {
  test("contact, code and comment fields compute to >= 16px at 360px; viewport allows zoom", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 360, height: 900 });
    try {
      const { page } = env;
      const meta = await page.getAttribute('meta[name="viewport"]', "content");
      assert.ok(!/maximum-scale|user-scalable/i.test(meta), `viewport blocks zoom: ${meta}`);
      await driveTo(page, "otp", { code: "" });
      const all = await sizes(page);
      assert.ok(all.length >= 10, `contact fields + 6 code cells + comment (got ${all.length})`);
      for (const f of all) assert.ok(f.px >= 16, `${f.id} is ${f.px}px (< 16px zooms on focus)`);
    } finally {
      await env.context.close();
    }
  });

  test("salon wizard: contact, code and per-card comment fields compute to >= 16px at 360px", async () => {
    const env = await salonPage(browser, "wiz-zoom-0001", { width: 360, height: 900 });
    try {
      const { page } = env;
      // toConfirm walks services -> masters -> time -> contact -> OTP -> the confirm cards, so every field of the wizard is in the DOM.
      await toConfirm(page, "501110061");
      const all = await sizes(page);
      assert.ok(all.length >= 10, `contact fields + 6 code cells + 2 comments (got ${all.length})`);
      assert.equal(await page.locator("#salon-cards textarea").count(), 2, "both per-master comment fields are among them");
      for (const f of all) assert.ok(f.px >= 16, `${f.id} is ${f.px}px (< 16px zooms on focus)`);
    } finally {
      await env.context.close();
    }
  });
});
