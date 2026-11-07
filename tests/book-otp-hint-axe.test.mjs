// Phase 029: the OTP step with the in-app "open in browser" hint visible has zero axe violations (360 px), and the phase-029 suites
// are never in CI's TEST_EXCLUDE (they must run on every PR through `npm test`).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { launch } from "./helpers/browser.mjs";
import { requireBase } from "./helpers/env.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";

requireBase();
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const IG_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.34.116 (iPhone14,5; iOS 17_5; uk_UA)";
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

describe("OTP step with the in-app hint", () => {
  test("hint visible: it is announced as text with a labelled close button, and axe finds no violation", async () => {
    const env = await bookPage(browser, "oksana-ab12", { userAgent: IG_IOS, width: 360 });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Автофіл", phone: "500000641" } });
      await env.page.click("#cta-contact");
      await env.page.waitForSelector("#otp", { state: "visible" });
      assert.equal(await env.page.locator("#otp-hint").isVisible(), true, "the hint is on screen for the sweep");
      assert.equal(await env.page.getByRole("button", { name: "Закрити підказку" }).isVisible(), true);
      await env.page.waitForTimeout(350); // animations settle: axe reads live colours
      await env.page.evaluate(AXE);
      const r = await env.page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }));
      assert.deepEqual(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`), []);
    } finally {
      await env.context.close();
    }
  });
});

describe("CI wiring", () => {
  test("the phase-029 suites are picked up by npm test (none in TEST_EXCLUDE)", () => {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const excluded = (/TEST_EXCLUDE:\s*([\w.,-]+)/.exec(ci)?.[1] ?? "").split(",").filter(Boolean);
    for (const f of ["otp-format.test.mjs", "book-otp-autofill.test.mjs", "book-otp-hint-axe.test.mjs", "book-webotp.test.mjs", "book-webotp-guards.test.mjs"]) {
      assert.equal(excluded.some((x) => f.includes(x)), false, `${f} must not be excluded`);
    }
  });
});
