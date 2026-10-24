// Phase 014 QA guards around WebOTP: it is armed only on the OTP step of the booking pages, and the code it delivers never reaches
// analytics, storage or the URL. Real browser, mock backend, nothing leaves localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { launch, open } from "./helpers/browser.mjs";
import { requireBase } from "./helpers/env.mjs";
import { BASE, ROOT } from "./helpers/env.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

// Counts every OTP credential request; resolves {code:"654321"} immediately. Also an analytics spy.
const SPY = `(() => {
  window.__events = [];
  window.umami = { track: (e, p) => window.__events.push({ e, p }) };
  window.__otpCalls = 0;
  window.OTPCredential = function OTPCredential() {};
  Object.defineProperty(navigator, "credentials", { configurable: true, value: { get(o) {
    if (o && o.otp) { window.__otpCalls++; return Promise.resolve({ code: "654321" }); }
    return Promise.reject(new Error("no"));
  } } });
})();`;

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

describe("WebOTP is confined to the booking OTP step", () => {
  test("only src/scripts/booking/ references OTPCredential / credentials.get", () => {
    const hits = walk(join(ROOT, "src")).filter((f) => /\.(ts|astro|js|mjs)$/.test(f) && /OTPCredential|credentials\??\.get/.test(readFileSync(f, "utf8")));
    assert.deepEqual(hits.map((f) => f.slice(ROOT.length + 1)), ["src/scripts/booking/app.ts"]);
  });

  for (const path of ["/", "/privacy", "/terms", "/support", "/delete-account", "/l/cancel", "/l/booking", "/l/invite", "/l/review"])
    test(`${path}: no OTP credential request`, async () => {
      const env = await open(browser, { width: 360, height: 800 });
      try {
        await env.context.addInitScript(SPY);
        await env.page.goto(`${BASE}${path}`, { waitUntil: "load" });
        await env.page.waitForTimeout(300); // settle: nothing to wait on when the correct behaviour is "nothing happens"
        assert.equal(await env.page.evaluate(() => window.__otpCalls), 0);
      } finally {
        await env.context.close();
      }
    });

  test("booking page: no request on load or on steps before the SMS step", async () => {
    const env = await bookPage(browser, "oksana-ab12", { init: SPY });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Веботп", phone: "500000051" } });
      assert.equal(await env.page.evaluate(() => window.__otpCalls), 0);
    } finally {
      await env.context.close();
    }
  });
});

describe("the SMS code never leaves the flow through analytics, storage or the URL", () => {
  test("track() calls in app.ts never take a code value", () => {
    const src = readFileSync(join(ROOT, "src/scripts/booking/app.ts"), "utf8");
    const block = src.slice(src.indexOf("function stopWebOtp"), src.indexOf("async function submitOtp"));
    assert.ok(block.length > 200, "WebOTP block not found");
    assert.equal(/\btrack\(/.test(block), false, "the WebOTP block must not emit analytics");
    for (const m of src.matchAll(/\btrack\(\s*"otp_\w+"[^)]*\)/g)) assert.doesNotMatch(m[0], /code\(\)|\bd\b|cred/, m[0]);
  });

  test("a WebOTP-filled booking: the code is in no analytics event, storage, cookie, history state or URL", async () => {
    const env = await bookPage(browser, "oksana-ab12", { init: SPY });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Веботп", phone: "500000052" } });
      await env.page.click("#cta-contact");
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      const seen = await env.page.evaluate(() => ({
        events: window.__events,
        rest: JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie, h: history.state, u: location.href, n: window.name }),
      }));
      assert.ok(seen.events.some((x) => x.e === "otp_verified"), "the flow went through verify");
      assert.equal(JSON.stringify(seen.events).includes("654321"), false, "analytics");
      assert.equal(seen.rest.includes("654321"), false, "storage / url / history");
    } finally {
      await env.context.close();
    }
  });
});
