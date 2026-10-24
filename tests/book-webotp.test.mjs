// Phase 014: one-tap OTP code fill. Attributes on the code input, and WebOTP (navigator.credentials.get({otp})) after a successful send:
// fills + submits through the manual path, aborts on back / resend / manual submit, silent when unsupported or rejected.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { requireBase } from "./helpers/env.mjs";
import { bookPage, mockLog, callsTo, driveTo } from "./helpers/book.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

// mode: "auto" resolves {code:'123456'} at once, "pending" waits for window.__otp.release(code), "reject" rejects, "none" = no OTPCredential.
const stub = (mode) => `(() => {
  if (${JSON.stringify(mode)} === "none") return;
  window.OTPCredential = function OTPCredential() {};
  window.__otp = { calls: [], release: null };
  const orig = navigator.credentials && navigator.credentials.get ? navigator.credentials.get.bind(navigator.credentials) : null;
  Object.defineProperty(navigator, "credentials", { configurable: true, value: { get(opts) {
    if (!opts || !opts.otp) return orig ? orig(opts) : Promise.reject(new Error("no"));
    const call = { transport: opts.otp.transport, signal: opts.signal, aborted: false };
    opts.signal.addEventListener("abort", () => (call.aborted = true));
    window.__otp.calls.push(call);
    return new Promise((res, rej) => {
      const m = ${JSON.stringify(mode)};
      if (m === "auto") res({ code: "123456" });
      else if (m === "reject") rej(new DOMException("denied", "NotAllowedError"));
      else {
        window.__otp.release = (code) => res({ code });
        opts.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      }
    });
  } } });
})();`;

async function toOtp(mode, phone) {
  const env = await bookPage(browser, "oksana-ab12", { init: stub(mode) });
  await driveTo(env.page, "contact", { contact: { name: "Веботп", phone } });
  await env.page.click("#cta-contact");
  // "auto" leaves the OTP step within a frame (fills + submits), so there is nothing stable to wait for here.
  if (mode !== "auto") await env.page.waitForSelector("#otp", { state: "visible" });
  return env;
}
const verifies = async (phone) => callsTo(await mockLog((e) => e.path.includes("/otp/") && e.body?.phone === phone), "POST", "/otp/verify");

describe("code input attributes", () => {
  test("first cell: one-time-code + numeric; pattern / maxlength kept", async () => {
    const env = await toOtp("none", "500000031");
    try {
      const a = (n, name) => env.page.locator("#otp input").nth(n).getAttribute(name);
      assert.equal(await a(0, "autocomplete"), "one-time-code");
      assert.equal(await a(0, "inputmode"), "numeric");
      assert.equal(await a(0, "pattern"), "[0-9]*");
      assert.equal(await a(0, "maxlength"), "1");
    } finally {
      await env.context.close();
    }
  });
});

describe("WebOTP", () => {
  test("requested with transport sms after the send; resolving fills the cells and submits exactly once", async () => {
    const env = await toOtp("auto", "500000032");
    try {
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.deepEqual(await env.page.evaluate(() => window.__otp.calls.map((c) => c.transport)), [["sms"]]);
      const v = await verifies("+380500000032");
      assert.equal(v.length, 1);
      assert.deepEqual(v[0].body, { phone: "+380500000032", code: "123456" });
    } finally {
      await env.context.close();
    }
  });

  test("going back aborts the request; a late code is ignored", async () => {
    const env = await toOtp("pending", "500000033");
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      await env.page.click("[data-screen=otp] [data-back]");
      await env.page.waitForSelector("[data-screen=contact]:not([hidden])");
      assert.equal(await env.page.evaluate(() => window.__otp.calls[0].aborted), true);
      assert.equal((await verifies("+380500000033")).length, 0);
    } finally {
      await env.context.close();
    }
  });

  test("resend aborts the old request and starts a new one; manual submit aborts it", async () => {
    const env = await toOtp("pending", "500000034");
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      // Skip the 60 s cooldown: reveal the resend button the way the cooldown end does.
      await env.page.evaluate(() => { document.querySelector("#otp-wait").hidden = true; document.querySelector("#otp-resend-btn").hidden = false; });
      await env.page.click("#otp-resend-btn");
      await env.page.waitForFunction(() => window.__otp.calls.length === 2);
      assert.deepEqual(await env.page.evaluate(() => window.__otp.calls.map((c) => c.aborted)), [true, false]);
      for (const [i, d] of [..."654321"].entries()) await env.page.locator("#otp input").nth(i).fill(d);
      await env.page.click("#cta-otp");
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.deepEqual(await env.page.evaluate(() => window.__otp.calls.map((c) => c.aborted)), [true, true]);
      assert.equal((await verifies("+380500000034")).length, 1, "manual submit only; the aborted request never submits again");
    } finally {
      await env.context.close();
    }
  });

  test("Back during an in-flight verify: stays on contact, no confirm screen, no token used later", async () => {
    const env = await toOtp("pending", "500000038");
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      let release;
      const gate = new Promise((r) => (release = r));
      let hit;
      const seen = new Promise((r) => (hit = r));
      await env.context.route("**/api/v1/book/otp/verify", async (route) => {
        hit();
        await gate;
        await route.continue();
      });
      await env.page.evaluate(() => window.__otp.release("123456"));
      await seen; // the verify request is in flight
      await env.page.click("[data-screen=otp] [data-back]");
      await env.page.waitForSelector("[data-screen=contact]:not([hidden])");
      release();
      await env.page.waitForTimeout(400);
      assert.equal(await env.page.locator("[data-screen=contact]").isVisible(), true);
      assert.equal(await env.page.locator("#confirm-card").isVisible(), false, "no confirm screen");
      assert.equal(callsTo(await mockLog((e) => e.path.includes("/book/") && e.method === "POST"), "POST", "/bookings").length, 0);
    } finally {
      await env.context.close();
    }
  });

  test("wrong code via WebOTP: the error shows and WebOTP is re-armed; the next SMS code fills and submits", async () => {
    const env = await toOtp("pending", "500000039");
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      await env.page.evaluate(() => window.__otp.release("000000"));
      await env.page.waitForSelector("#otp-wrong", { state: "visible" });
      await env.page.waitForFunction(() => window.__otp.calls.length === 2);
      assert.equal(await env.page.evaluate(() => window.__otp.calls[1].aborted), false, "re-armed and live");
      await env.page.evaluate(() => window.__otp.release("123456"));
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.deepEqual((await verifies("+380500000039")).map((v) => v.body.code), ["000000", "123456"]);
    } finally {
      await env.context.close();
    }
  });

  test("a code arriving during a slow resend is ignored (old request aborted); after the resend the new request fills and submits once", async () => {
    const env = await toOtp("pending", "500000040");
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      let release;
      const gate = new Promise((r) => (release = r));
      await env.context.route("**/api/v1/book/otp/send", async (route) => {
        await gate;
        await route.continue();
      });
      await env.page.evaluate(() => { document.querySelector("#otp-wait").hidden = true; document.querySelector("#otp-resend-btn").hidden = false; });
      await env.page.click("#otp-resend-btn");
      await env.page.evaluate(() => window.__otp.release("111111"));
      await env.page.waitForTimeout(200);
      assert.equal((await verifies("+380500000040")).length, 0, "no submit during the resend");
      release();
      await env.page.waitForFunction(() => window.__otp.calls.length === 2);
      await env.page.evaluate(() => window.__otp.release("123456"));
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.deepEqual((await verifies("+380500000040")).map((v) => v.body.code), ["123456"]);
    } finally {
      await env.context.close();
    }
  });

  test("a failed resend keeps listening: WebOTP is re-armed and the earlier SMS code still submits", async () => {
    const env = await toOtp("pending", "500000041");
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      await env.context.route("**/api/v1/book/otp/send", (route) =>
        route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*", "content-type": "application/json", "retry-after": "30" }, body: '{"success":false}' }));
      await env.page.evaluate(() => { document.querySelector("#otp-wait").hidden = true; document.querySelector("#otp-resend-btn").hidden = false; });
      await env.page.click("#otp-resend-btn");
      await env.page.waitForSelector("#otp-sms", { state: "visible" });
      await env.page.waitForFunction(() => window.__otp.calls.length === 2);
      assert.deepEqual(await env.page.evaluate(() => window.__otp.calls.map((c) => c.aborted)), [true, false]);
      await env.page.evaluate(() => window.__otp.release("123456"));
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.equal((await verifies("+380500000041")).length, 1);
    } finally {
      await env.context.close();
    }
  });

  test("rejected: silent, manual entry still works", async () => {
    const env = await toOtp("reject", "500000035");
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      await env.page.waitForTimeout(150);
      assert.equal(await env.page.locator("[data-screen=otp]").isVisible(), true);
      assert.equal((await verifies("+380500000035")).length, 0);
      assert.deepEqual(env.problems, []);
    } finally {
      await env.context.close();
    }
  });

  test("unsupported (no OTPCredential): no call, no error, manual entry works", async () => {
    const env = await toOtp("none", "500000036");
    try {
      await env.page.waitForTimeout(150);
      assert.equal(await env.page.locator("[data-screen=otp]").isVisible(), true);
      assert.deepEqual(env.problems, []);
      for (const [i, d] of [..."123456"].entries()) await env.page.locator("#otp input").nth(i).fill(d);
      await env.page.click("#cta-otp");
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
    } finally {
      await env.context.close();
    }
  });

  test("Permissions-Policy does not deny otp-credentials on /book/*", async () => {
    const env = await toOtp("none", "500000037");
    try {
      const pp = env.res.headers()["permissions-policy"] ?? "";
      assert.equal(/otp-credentials/.test(pp), false);
    } finally {
      await env.context.close();
    }
  });
});
