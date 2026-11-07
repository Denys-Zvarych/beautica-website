// Phase 029: smsFormat on /otp/send per browser, auto-submit when autofill delivers a whole code, value changes without `input`
// events, WebOTP abort on pagehide, the in-app "open in browser" hint, and the code input staying visible to autofill.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { requireBase } from "./helpers/env.mjs";
import { bookPage, mockLog, callsTo, driveTo } from "./helpers/book.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const UA = {
  instagramIos: `${IOS} Mobile/15E148 Instagram 330.0.0.34.116 (iPhone14,5; iOS 17_5; uk_UA)`,
  safariIos: `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`,
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36",
  instagramAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.165 Mobile Safari/537.36 Instagram 330.0.0.38.92 Android (34/14; 420dpi)",
};
// "pending": a WebOTP request that waits for window.__otp.release(code).
const webotp = `(() => {
  window.OTPCredential = function OTPCredential() {};
  window.__otp = { calls: [], release: null };
  Object.defineProperty(navigator, "credentials", { configurable: true, value: { get(opts) {
    const call = { aborted: false };
    opts.signal.addEventListener("abort", () => (call.aborted = true));
    window.__otp.calls.push(call);
    return new Promise((res, rej) => {
      window.__otp.release = (code) => res({ code });
      opts.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    });
  } } });
})();`;
const proxyStub = `window.TelegramWebviewProxy = { postEvent() {} };`;

async function toOtp(phone, opts = {}) {
  const env = await bookPage(browser, "oksana-ab12", opts);
  // Counted at dispatch in the browser, so a verify still in flight is seen (the mock log only shows requests that have arrived).
  env.verifyRequests = [];
  env.page.on("request", (r) => r.url().includes("/otp/verify") && env.verifyRequests.push(r.url()));
  await driveTo(env.page, "contact", { contact: { name: "Автофіл", phone } });
  await env.page.click("#cta-contact");
  await env.page.waitForSelector("#otp", { state: "visible" });
  return env;
}
const full = (p) => `+380${p}`;
const sends = async (p) => callsTo(await mockLog((e) => e.path.includes("/otp/") && e.body?.phone === full(p)), "POST", "/otp/send");
const verifies = async (p) => callsTo(await mockLog((e) => e.path.includes("/otp/") && e.body?.phone === full(p)), "POST", "/otp/verify");
// Two animation frames: any handler queued by the last event (input, blur, visibilitychange, a resolved promise) has run. A condition, not a delay.
const frames = (page) => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
// Poll a condition until it holds (no fixed sleep); the test timeout is the only bound.
async function until(fn) {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("smsFormat on /otp/send", () => {
  for (const [name, ua, init, phone, want] of [
    ["Instagram on iOS -> PLAIN", UA.instagramIos, undefined, "500000601", "PLAIN"],
    ["iOS Safari -> DOMAIN_BOUND", UA.safariIos, undefined, "500000602", "DOMAIN_BOUND"],
    ["Android Chrome -> DOMAIN_BOUND", UA.chromeAndroid, undefined, "500000603", "DOMAIN_BOUND"],
    ["Telegram proxy with a Safari UA -> PLAIN", UA.safariIos, proxyStub, "500000604", "PLAIN"],
  ]) {
    test(name, async () => {
      const env = await toOtp(phone, { userAgent: ua, init });
      try {
        const s = await sends(phone);
        assert.equal(s.length, 1);
        assert.equal(s[0].body.smsFormat, want);
      } finally {
        await env.context.close();
      }
    });
  }
  test("resend sends the same format", async () => {
    const env = await toOtp("500000605", { userAgent: UA.instagramIos });
    try {
      await env.page.evaluate(() => { document.querySelector("#otp-wait").hidden = true; document.querySelector("#otp-resend-btn").hidden = false; });
      await env.page.click("#otp-resend-btn");
      await env.page.waitForFunction(() => document.querySelector("#otp-wait") && !document.querySelector("#otp-resend-btn").disabled);
      await until(async () => (await sends("500000605")).length >= 2);
      const s = await sends("500000605");
      assert.deepEqual(s.map((x) => x.body.smsFormat), ["PLAIN", "PLAIN"]);
    } finally {
      await env.context.close();
    }
  });
});

describe("auto-submit", () => {
  test("6 digits in one input event (insertReplacementText) submit once, no tap", async () => {
    const env = await toOtp("500000611");
    try {
      await env.page.evaluate(() => {
        const i = document.querySelector("#otp-input");
        i.value = "123456";
        i.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: "123456" }));
      });
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.equal((await verifies("500000611")).length, 1);
    } finally {
      await env.context.close();
    }
  });

  test("typing 6 digits one by one does not submit (the button does)", async () => {
    const env = await toOtp("500000612");
    try {
      await env.page.locator("#otp-input").pressSequentially("123456");
      await env.page.waitForFunction(() => document.querySelector("#otp-input").value === "123456" && !document.querySelector("#cta-otp").disabled);
      await frames(env.page);
      assert.equal(env.verifyRequests.length, 0);
      assert.equal((await verifies("500000612")).length, 0);
      assert.equal(await env.page.locator("#cta-otp").isDisabled(), false);
      await env.page.click("#cta-otp");
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.equal((await verifies("500000612")).length, 1);
    } finally {
      await env.context.close();
    }
  });

  test("value set by script with no input event: blur mirrors the cells and submits once", async () => {
    const env = await toOtp("500000613");
    try {
      await env.page.evaluate(() => { const i = document.querySelector("#otp-input"); i.focus(); i.value = "123456"; });
      await env.page.evaluate(() => document.querySelector("#otp-input").blur());
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.equal((await verifies("500000613")).length, 1);
    } finally {
      await env.context.close();
    }
  });

  test("value set by script, then the page becomes visible again: submits once", async () => {
    const env = await toOtp("500000614");
    try {
      await env.page.evaluate(() => { document.querySelector("#otp-input").value = "123456"; document.dispatchEvent(new Event("visibilitychange")); });
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      assert.equal((await verifies("500000614")).length, 1);
    } finally {
      await env.context.close();
    }
  });

  test("WebOTP resolve + a simultaneous input fill: exactly one verify", async () => {
    const env = await toOtp("500000615", { init: webotp });
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      await env.page.evaluate(() => {
        const i = document.querySelector("#otp-input");
        i.value = "123456";
        i.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
        window.__otp.release("123456");
      });
      await env.page.waitForSelector("#confirm-card", { state: "visible" });
      await frames(env.page);
      assert.equal(env.verifyRequests.length, 1);
      assert.equal((await verifies("500000615")).length, 1);
    } finally {
      await env.context.close();
    }
  });

  test("pagehide aborts the pending WebOTP request", async () => {
    const env = await toOtp("500000616", { init: webotp });
    try {
      await env.page.waitForFunction(() => window.__otp.calls.length === 1);
      await env.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      assert.equal(await env.page.evaluate(() => window.__otp.calls[0].aborted), true);
    } finally {
      await env.context.close();
    }
  });
});

describe("no in-app hint", () => {
  test("the removed in-app browser hint is not rendered for an iOS Instagram UA", async () => {
    const env = await toOtp("500000621", { userAgent: UA.instagramIos });
    try {
      assert.equal(await env.page.locator("#otp-hint").count(), 0);
      assert.equal(await env.page.locator("#otp-hint-x").count(), 0);
    } finally {
      await env.context.close();
    }
  });
});

describe("code input stays visible to autofill", () => {
  test("not hidden, covers the cells' row, name + enterkeyhint set", async () => {
    const env = await toOtp("500000631");
    try {
      const r = await env.page.evaluate(() => {
        const i = document.querySelector("#otp-input");
        const cs = getComputedStyle(i);
        const b = i.getBoundingClientRect();
        const cells = [...document.querySelectorAll("#otp .otp-cell")].map((c) => c.getBoundingClientRect());
        return {
          opacity: cs.opacity, display: cs.display, visibility: cs.visibility, fontSize: parseFloat(cs.fontSize),
          covers: cells.every((c) => b.left <= c.left + 1 && b.right >= c.right - 1 && b.top <= c.top + 1 && b.bottom >= c.bottom - 1),
          name: i.getAttribute("name"), ekh: i.getAttribute("enterkeyhint"),
        };
      });
      assert.notEqual(r.opacity, "0");
      assert.notEqual(r.display, "none");
      assert.notEqual(r.visibility, "hidden");
      assert.ok(r.fontSize >= 16);
      assert.equal(r.covers, true);
      assert.equal(r.name, "otp");
      assert.equal(r.ekh, "done");
    } finally {
      await env.context.close();
    }
  });
});
