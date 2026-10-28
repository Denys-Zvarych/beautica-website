// The backend verifies the Turnstile token against `app.turnstile.expected-action` (prod: "otp_send"); a widget rendered without that action
// yields tokens the backend rejects with 400 on every /book/otp/send. Pin the render options at the contact step.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";
import { requireBase } from "./helpers/env.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

describe("booking flow: Turnstile widget", () => {
  test('renders with action "otp_send" and the uk/light options', async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      await driveTo(page, "time");
      await page.click("#cta-time");
      await page.waitForSelector("#ts-widget iframe", { state: "attached" });
      const opts = await page.evaluate(() => window.__tsOpts);
      assert.equal(opts.action, "otp_send", `render options: ${JSON.stringify(opts)}`);
      assert.equal(opts.language, "uk");
      assert.equal(opts.theme, "light");
    } finally {
      await env.context.close();
    }
  });
});
