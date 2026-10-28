// Fix `ios-otp-autofill-ics` QA: «Додати в календар» routes by device. iOS Safari ignores `<a download>` on blobs, so iPhone / iPad / iPadOS
// (Macintosh UA + touch) share the .ics as a File, or navigate to a data:text/calendar URL; every other device keeps the blob download.
// Plus the OTP step is ONE autofill target (autocomplete=one-time-code, maxlength=6) whose cells mirror a whole-code single input event.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipados: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** Init script (runs before the page): fake share API per `cfg.share` and a log in window.__ics. Navigation to data: is recorded and cancelled via the Navigation API. */
const stubs = (cfg) => `(${(c) => {
  window.__ics = { shared: [], canShareCalls: 0, navs: [], navTypes: [] };
  if (c.touch != null) Object.defineProperty(navigator, "maxTouchPoints", { get: () => c.touch });
  if (c.share === "absent") {
    delete Navigator.prototype.share;
    delete Navigator.prototype.canShare;
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true });
  } else {
    navigator.canShare = (d) => (window.__ics.canShareCalls++, c.canShare !== false && Array.isArray(d?.files));
    navigator.share = (d) => {
      window.__ics.shared.push({ n: d.files.length, type: d.files[0].type, name: d.files[0].name, size: d.files[0].size, text: null, files: d.files });
      const p = c.share === "resolve" ? Promise.resolve() : Promise.reject(new DOMException("x", c.share === "abort" ? "AbortError" : "NotAllowedError"));
      window.__ics.settled = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 0))); // after the page's own .catch handler ran
      return p;
    };
  }
  window.navigation?.addEventListener("navigate", (e) => {
    if (e.destination.url.startsWith("data:")) {
      window.__ics.navs.push(e.destination.url);
      window.__ics.navTypes.push(e.navigationType); // "push" adds a history entry, "replace" overwrites the confirmation
      e.preventDefault(); // stay on the page
    }
  });
  window.__blobs = 0;
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => (window.__blobs++, create(b));
}})(${JSON.stringify(cfg)})`;

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

/** Books through the real flow up to the success screen, taps «Додати в календар». */
async function tapCalendar(slug, { ua, cfg }) {
  const env = await bookPage(browser, slug, { userAgent: ua, hasTouch: ua !== UA.desktop, init: stubs(cfg) });
  try {
    await driveTo(env.page, "confirm", { contact: { name: "Айос", phone: slug === "oksana-ab12" ? "500000031" : "500000032" } });
    await env.page.click("#cta-confirm");
    await env.page.waitForSelector("#done-card", { state: "visible" });
    const download = env.page.waitForEvent("download", { timeout: 1500 }).catch(() => null);
    await env.page.getByRole("button", { name: "Додати в календар" }).click();
    // wait on a condition: either the share/data nav was observed, or (desktop) the download event
    const d = await download;
    await env.page.waitForFunction(() => window.__ics.shared.length + window.__ics.navs.length + window.__blobs > 0);
    const out = await env.page.evaluate(async () => {
      await window.__ics.settled; // a rejected share has been handled by the page by now: absence assertions are not racing it
      const f = window.__ics.shared[0]?.files[0];
      return { ...window.__ics, files: undefined, blobs: window.__blobs, fileText: f ? await f.text() : null, url: location.href };
    });
    return { ...out, download: d ? d.suggestedFilename() : null, problems: env.problems };
  } finally {
    await env.context.close();
  }
}

describe("add to calendar on iOS", () => {
  test("iPhone: share sheet gets exactly one text/calendar .ics File; no navigation, no blob download", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.iphone, cfg: { share: "resolve" } });
    assert.equal(r.shared.length, 1, "share called once");
    assert.equal(r.shared[0].n, 1, "one file");
    assert.equal(r.shared[0].type, "text/calendar");
    assert.match(r.shared[0].name, /\.ics$/);
    assert.match(r.fileText, /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/, "the file is the real calendar text");
    assert.deepEqual(r.navs, [], "no data: navigation after a successful share");
    assert.equal(r.blobs, 0, "no blob URL");
    assert.equal(r.download, null);
  });

  test("iPhone: the user dismisses the sheet (AbortError) -> nothing else happens", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.iphone, cfg: { share: "abort" } });
    assert.equal(r.shared.length, 1);
    assert.deepEqual(r.navs, [], "AbortError must not navigate");
    assert.equal(r.blobs, 0);
  });

  test("iPhone: share rejects with another error -> falls back to a data:text/calendar navigation carrying the file", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.iphone, cfg: { share: "fail" } });
    assert.equal(r.shared.length, 1);
    assert.equal(r.navs.length, 1);
    assert.match(r.navs[0], /^data:text\/calendar;charset=utf-8,BEGIN%3AVCALENDAR/);
    assert.deepEqual(r.navTypes, ["push"], "the data: fallback adds a history entry, so Back returns to the confirmation");
    assert.match(decodeURIComponent(r.navs[0].split(",").slice(1).join(",")), /^BEGIN:VCALENDAR\r\n[\s\S]*SUMMARY:[\s\S]*END:VCALENDAR\r\n$/);
    assert.equal(r.blobs, 0);
  });

  test("iPhone: canShare says no for files -> data:text/calendar navigation, share never called", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.iphone, cfg: { share: "resolve", canShare: false } });
    assert.equal(r.shared.length, 0);
    assert.equal(r.navs.length, 1);
    assert.match(r.navs[0], /^data:text\/calendar/);
  });

  test("iPhone: no Web Share API at all -> data:text/calendar navigation", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.iphone, cfg: { share: "absent" } });
    assert.equal(r.navs.length, 1);
    assert.match(r.navs[0], /^data:text\/calendar/);
  });

  test("iPadOS (Macintosh UA + 5 touch points) is treated as iOS: share used, no blob download", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.ipados, cfg: { share: "resolve", touch: 5 } });
    assert.equal(r.shared.length, 1);
    assert.equal(r.blobs, 0);
    assert.equal(r.download, null);
  });

  test("a Mac (Macintosh UA, no touch) is NOT iOS: blob download, share not called", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.ipados, cfg: { share: "resolve", touch: 0 } });
    assert.equal(r.shared.length, 0);
    assert.equal(r.blobs, 1);
  });
});

describe("add to calendar elsewhere", () => {
  test("desktop: blob <a download> still used (download event, .ics name) and share is NOT called", async () => {
    const r = await tapCalendar("oksana-ab12", { ua: UA.desktop, cfg: { share: "resolve" } });
    assert.equal(r.shared.length, 0, "navigator.share untouched on desktop");
    assert.equal(r.canShareCalls, 0);
    assert.equal(r.blobs, 1);
    assert.deepEqual(r.navs, []);
    assert.equal(r.download, "beautica-booking.ics");
  });
});

describe("OTP step is a single iOS-autofill target", () => {
  test("one input[autocomplete=one-time-code][maxlength=6]; a whole 6-digit code in ONE input event fills all cells and enables the CTA", async () => {
    const env = await bookPage(browser, "oksana-ab12", { userAgent: UA.iphone, hasTouch: true });
    try {
      await driveTo(env.page, "contact", { contact: { name: "Автозаповнення", phone: "500000033" } });
      await env.page.click("#cta-contact");
      await env.page.waitForSelector("#otp", { state: "visible" });
      const field = env.page.locator("#otp input");
      assert.equal(await field.count(), 1, "exactly one input in the OTP block (old markup had six)");
      assert.equal(await field.getAttribute("autocomplete"), "one-time-code");
      assert.equal(await field.getAttribute("maxlength"), "6");
      assert.equal(await env.page.locator("#cta-otp").isDisabled(), true, "disabled before the code");
      await field.evaluate((el) => {
        el.value = "482915"; // what iOS QuickType autofill does: the entire code, one event
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.deepEqual(await env.page.locator("#otp .otp-cell").evaluateAll((els) => els.map((e) => e.textContent)), [..."482915"]);
      assert.equal(await env.page.locator("#cta-otp").isEnabled(), true);
      assert.deepEqual(env.problems, []);
    } finally {
      await env.context.close();
    }
  });
});
