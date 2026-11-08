// Phase 031: iOS phone autofill keeps all 9 digits (no maxlength on #phone), the OTP keyboard proxy hands focus to #otp-input,
// and the Apple-calendar button of every iOS in-app browser (Instagram, Facebook, Telegram) follows the x-safari link by script (plain iOS Safari keeps the anchor).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { uk } from "./helpers/env.mjs";
import { bookPage, mockLog, callsTo, driveTo } from "./helpers/book.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const UA = {
  instagramIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24B119 Instagram 454.1.0.41.71 (iPhone15,4; iOS 27_2; en_GB; en-GB; scale=3.00; 1179x2556; IABMV/1; 1106185088) Safari/604.1",
  facebookIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24B119 [FBAN/FBIOS;FBAV/480.0.0.40.104;FBBV/123;FBDV/iPhone15,4;FBMD/iPhone;FBSN/iOS;FBSV/27.2;FBSS/3;FBCR/;FBID/phone;FBLC/uk_UA;FBOP/5]",
  telegramIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};
const telegramProxy = `window.TelegramWebviewProxy = { postEvent() {} };`;
const sends = async (e164) => callsTo(await mockLog((e) => e.body?.phone === e164), "POST", "/otp/send");
async function until(fn) {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("phone autofill (single fill of a whole number)", () => {
  for (const [name, fill, seed] of [
    ["iOS format +38 (050) 123-45-67", (s) => `+38 (0${s.slice(0, 2)}) ${s.slice(2, 5)}-${s.slice(5, 7)}-${s.slice(7)}`, "500000711"],
    ["E.164 +380501234567", (s) => `+380${s}`, "500000712"],
  ])
    test(`${name}: the field keeps all 9 national digits and /otp/send carries +380…`, async () => {
      const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: UA.telegramIos, hasTouch: true });
      try {
        await driveTo(env.page, "contact", { contact: { name: "Автофіл", phone: seed } });
        const filled = fill(seed);
        await env.page.fill("#phone", filled);
        assert.equal(await env.page.getAttribute("#phone", "maxlength"), null, "#phone has no maxlength");
        const digits = await env.page.inputValue("#phone");
        assert.match(digits.replace(/\D/g, ""), new RegExp(`^(380)?${seed}$`), `field after fill(${filled}): ${digits}`); // all 9 national digits, optional +380 prefix of the mask
        await env.page.click("#cta-contact");
        await env.page.waitForSelector("#otp", { state: "visible" });
        const s = await until(async () => { const r = await sends(`+380${seed}`); return r.length ? r : null; });
        assert.equal(s.length, 1);
      } finally {
        await env.context.close();
      }
    });
});

describe("OTP keyboard proxy", () => {
  test("the proxy is focused synchronously in the submit tap, then #otp-input takes focus when the OTP step shows", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: UA.telegramIos, hasTouch: true });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Проксі", phone: "500000721" } });
      // window (bubble) runs after the form's own submit handler, still in the same synchronous turn.
      await env.page.evaluate(() => window.addEventListener("submit", () => (window.__activeAtSubmit = document.activeElement?.id), false));
      await env.page.click("#cta-contact");
      await env.page.waitForSelector("#otp", { state: "visible" });
      await env.page.waitForFunction(() => document.activeElement?.id === "otp-input");
      assert.equal(await env.page.evaluate(() => window.__activeAtSubmit), "otp-proxy");
    } finally {
      await env.context.close();
    }
  });

  test("proxy markup: aria-hidden=true, tabindex=-1, no name", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 393 });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Розмітка", phone: "500000722" } });
      const p = env.page.locator("#otp-proxy");
      assert.equal(await p.getAttribute("aria-hidden"), "true");
      assert.equal(await p.getAttribute("tabindex"), "-1");
      assert.equal(await p.getAttribute("name"), null);
    } finally {
      await env.context.close();
    }
  });

  test("a failed send (503) does not leave focus on the proxy and stays on the contact step", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: UA.telegramIos, hasTouch: true });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Збій", phone: "500000503" } });
      await env.page.evaluate(() => window.addEventListener("submit", () => (window.__activeAtSubmit = document.activeElement?.id), false));
      await env.page.click("#cta-contact");
      await env.page.waitForFunction(() => ["#cb-sms", "#cb-error"].some((s) => !document.querySelector(s).hidden));
      assert.equal(await env.page.evaluate(() => window.__activeAtSubmit), "otp-proxy", "focus was on the proxy during the tap");
      assert.notEqual(await env.page.evaluate(() => document.activeElement?.id), "otp-proxy");
      assert.equal(await env.page.locator("#otp").isVisible(), false);
    } finally {
      await env.context.close();
    }
  });
});

describe("Apple calendar button in iOS in-app browsers", () => {
  // Records, after the button's own listener, whether the click was cancelled and every navigation the page starts.
  const spy = () => {
    window.__nav = { defaultPrevented: null, urls: [] };
    window.addEventListener("click", (e) => { if (e.target.closest?.(".calbtn")) window.__nav.defaultPrevented = e.defaultPrevented; }, false);
    window.navigation?.addEventListener("navigate", (e) => window.__nav.urls.push(e.destination.url));
  };
  async function tapApple(ua, extraInit) {
    const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: ua, hasTouch: true, init: `(${spy})();${extraInit ?? ""}` });
    try {
      await driveTo(env.page, "confirm", { contact: { name: "Календар", phone: "500000731" } });
      await env.page.click("#cta-confirm");
      await env.page.waitForSelector("#done-card", { state: "visible" });
      const apple = env.page.getByRole("link", { name: uk.book.done.calendarApple });
      const href = await apple.getAttribute("href");
      await env.page.route("**/api/ics?**", (r) => r.fulfill({ status: 200, contentType: "text/calendar", headers: { "content-disposition": "attachment" }, body: "x" })); // a download: the page stays
      await apple.click().catch(() => {});
      await env.page.waitForFunction(() => window.__nav.defaultPrevented !== null);
      const nav = await env.page.evaluate(() => window.__nav);
      return { href, nav: { ...nav, urls: nav.urls.filter((u) => u.startsWith("x-safari-")) } };
    } finally {
      await env.context.close();
    }
  }

  for (const [name, ua, init] of [["Instagram", UA.instagramIos, ""], ["Facebook", UA.facebookIos, ""], ["Telegram", UA.telegramIos, telegramProxy]])
  test(`${name} iOS: click is cancelled and the page itself navigates to x-safari-https://…/api/ics?…`, async () => {
    const { href, nav } = await tapApple(ua, init);
    assert.match(href, /^x-safari-https?:\/\/[^/]+\/api\/ics\?/);
    assert.equal(nav.defaultPrevented, true, "anchor default action is replaced by a scripted navigation");
    assert.deepEqual(nav.urls, [href]);
  });

  test("plain iOS Safari: x-safari is not used, click not intercepted", async () => {
    const { href, nav } = await tapApple(UA.telegramIos);
    assert.match(href, /^\/api\/ics\?/);
    assert.equal(nav.defaultPrevented, false, "no click override on Safari");
  });
});
