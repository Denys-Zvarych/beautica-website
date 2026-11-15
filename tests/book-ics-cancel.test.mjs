// Phase 030 QA: the cancel link in «Додати в календар» on BOTH done screens (master + salon): Google details line, Apple c= token and the .ics it returns, the Google link's
// rel/target (the bearer token must not leak via Referer), the 500-char cap that never cuts the cancel line, and the iOS in-app hint only where it belongs.
import { DESCRIPTION_MAX } from "../src/scripts/booking/ics-lines.ts";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { BASE, uk } from "./helpers/env.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";
import { salonPage, toConfirm } from "./helpers/salon.mjs";
import { parseIcs } from "./helpers/ics-parse.mjs";
import { CANCEL_URL } from "./helpers/mock-api.mjs";
import { calendarLinks, isIosInApp } from "../src/scripts/booking/calendar-links.ts";

const ORIGIN = new URL(BASE).origin;
const tokenOf = (u) => u.split("/").pop();
const LINE = (path) => `${uk.book.ics.cancel}: ${ORIGIN}${path}`;
const UA = {
  iosSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iosTelegram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  androidInstagram: "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Instagram 330.0.0.1",
  iosInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.1",
};

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

/** Reads both calendar buttons of one booking card. */
const buttons = (scope) => scope.locator(".calbtn").evaluateAll((as) => as.map((a) => ({ k: a.dataset.cal, href: a.getAttribute("href"), rel: a.rel, target: a.getAttribute("target") })));
const detailsOf = (href) => new URL(href.startsWith("intent://") ? `https://${href.slice("intent://".length).split("#")[0]}` : href).searchParams.get("details");

describe("master done screen: the cancel link reaches both calendar links", () => {
  test("Google: target=_blank + rel has noopener AND noreferrer (no token in Referer); details end with the cancel line; Apple: c = the token, and /api/ics answers with that link", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: UA.iosSafari });
    try {
      await driveTo(env.page, "confirm", { contact: { name: "Скасування" } });
      await env.page.click("#cta-confirm");
      await env.page.waitForSelector("#done-card", { state: "visible" });
      const rows = await buttons(env.page.locator("#done-card"));
      const g = rows.find((r) => r.k === "google");
      const a = rows.find((r) => r.k === "apple");
      assert.equal(g.target, "_blank");
      for (const r of rows) assert.deepEqual(r.rel.split(/\s+/).filter((t) => ["noopener", "noreferrer"].includes(t)).sort(), ["noopener", "noreferrer"], `${r.k} rel: ${r.rel}`);
      assert.ok(detailsOf(g.href).endsWith(LINE(new URL(CANCEL_URL).pathname)), detailsOf(g.href));
      const u = new URL(a.href, BASE);
      assert.equal(u.searchParams.get("c"), tokenOf(CANCEL_URL));
      const ics = parseIcs(await (await env.page.request.get(u.href)).text());
      assert.equal(ics.VEVENT.URL, `${ORIGIN}${new URL(CANCEL_URL).pathname}`);
    } finally {
      await env.context.close();
    }
  });
});

describe("salon done screen: each master's booking carries its own cancel link", () => {
  test("two cards: Google details + Apple c + the returned .ics hold that booking's token (distinct per master); Google rel/target pinned", async () => {
    const env = await salonPage(browser, "wiz-ics-cancel-0001");
    try {
      const { page } = env;
      await toConfirm(page, "501110031");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-list [data-done]", { state: "visible" });
      const cards = page.locator("#done-list [data-done]").filter({ has: page.locator(".calbtn") });
      assert.equal(await cards.count(), 2);
      const seen = [];
      for (let i = 0; i < 2; i++) {
        const rows = await buttons(cards.nth(i));
        const g = rows.find((r) => r.k === "google");
        const a = rows.find((r) => r.k === "apple");
        assert.equal(g.target, "_blank");
        for (const r of rows) assert.deepEqual(r.rel.split(/\s+/).sort(), ["noopener", "noreferrer"], `${r.k} rel`);
        const token = new URL(a.href, BASE).searchParams.get("c");
        assert.match(token, /^123e4567-e89b-42d3-a456-42661417400\d$/);
        seen.push(token);
        assert.ok(detailsOf(g.href).endsWith(LINE(`/book/cancel/${token}`)), detailsOf(g.href));
        const ics = parseIcs(await (await page.request.get(new URL(a.href, BASE).href)).text());
        assert.equal(ics.VEVENT.URL, `${ORIGIN}/book/cancel/${token}`);
        assert.ok(ics.text.DESCRIPTION.endsWith(LINE(`/book/cancel/${token}`)));
      }
      assert.equal(new Set(seen).size, 2, "one token per booking");
    } finally {
      await env.context.close();
    }
  });
});

describe("the cancel line survives the Google details cap", () => {
  const ev = { startsAt: "2026-11-08T12:00:00Z", minutes: 60, title: "Запис", location: "" };
  for (const [name, url] of [["short token", "https://beautica.app/c/Ab3dEf7hJk9mNp2Q"], ["legacy uuid token", CANCEL_URL]])
    test(`${name}: 90 very long services -> details is <= DESCRIPTION_MAX, the services text is cut with an ellipsis, the line is whole at the end`, () => {
      const description = "Послуги: " + Array.from({ length: 90 }, (_, i) => `Надзвичайно довга назва послуги ${i}`).join(", ");
      const d = new URL(calendarLinks({ ...ev, description, cancel: { url, label: uk.book.ics.cancel } }).google).searchParams.get("details");
      const line = `${uk.book.ics.cancel}: ${url}`;
      assert.ok(d.length <= DESCRIPTION_MAX, String(d.length));
      assert.ok(d.endsWith(`…\n${line}`), d);
    });
});

describe("phase 031: every iOS in-app browser gets the x-safari href (and the scripted click in app.ts); Safari / Android do not", () => {
  const PROD_IG = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24B119 Instagram 454.1.0.41.71 (iPhone15,4; iOS 27_2; en_GB; en-GB; scale=3.00; 1179x2556; IABMV/1; 1106185088) Safari/604.1";
  test("isIosInApp: prod Instagram UA, FBAN, FBAV, Telegram proxy -> true; plain Safari, Android Instagram -> false", () => {
    assert.equal(isIosInApp(PROD_IG), true);
    assert.equal(isIosInApp(UA.iosInstagram), true);
    assert.equal(isIosInApp(UA.iosSafari.replace("Safari/604.1", "FBAN/FBIOS")), true);
    assert.equal(isIosInApp(UA.iosSafari.replace("Safari/604.1", "FBAV/450")), true);
    assert.equal(isIosInApp({ ua: UA.iosSafari, maxTouchPoints: 5, hasTelegramProxy: true }), true);
    assert.equal(isIosInApp(UA.iosSafari), false);
    assert.equal(isIosInApp(UA.androidInstagram), false);
  });
  test("the prod Instagram UA still gets the x-safari href", () => {
    assert.ok(calendarLinks({ startsAt: "2026-11-10T09:00:00Z", minutes: 60, title: "t", description: "d", location: "" }, PROD_IG, ORIGIN).apple.startsWith(`x-safari-${ORIGIN}/api/ics?`));
  });
});

describe("the in-app hint and x-safari link are for iOS Instagram / Facebook only", () => {
  test("isIosInApp: iPhone / iPad with Instagram, FBAN, FBAV -> true; Android with the same markers or plain iOS -> false", () => {
    for (const m of ["Instagram 330.0", "FBAN/FBIOS", "FBAV/450", "FBAN/MessengerForiOS"]) {
      assert.equal(isIosInApp(`Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 ${m}`), true, m);
      assert.equal(isIosInApp(`Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) Mobile/15E148 ${m}`), true, m);
      assert.equal(isIosInApp(`Mozilla/5.0 (Linux; Android 14) ${m}`), false, m);
    }
    assert.equal(isIosInApp(UA.iosSafari) || isIosInApp(UA.iosTelegram), false);
  });
  const env = (ua, hasTelegramProxy = false, maxTouchPoints = 5) => ({ ua, maxTouchPoints, hasTelegramProxy });
  const href = (e) => calendarLinks({ startsAt: "2026-12-01T10:00:00Z", minutes: 60, title: "t", description: "d", location: "" }, e, ORIGIN).apple;
  test("iPhone Safari UA + TelegramWebviewProxy -> x-safari; iPhone WhatsApp -> x-safari; iPadOS Macintosh+touch Telegram -> x-safari", () => {
    assert.ok(href(env(UA.iosSafari, true)).startsWith(`x-safari-${ORIGIN}/api/ics?`));
    assert.ok(href(env(UA.iosTelegram, true)).startsWith(`x-safari-${ORIGIN}/api/ics?`));
    assert.ok(href(env(UA.iosSafari.replace("Safari/604.1", "WhatsApp/2.24"))).startsWith("x-safari-"));
    assert.ok(href(env("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", true)).startsWith("x-safari-"));
  });
  test("Android Telegram (proxy) and iOS Safari without proxy stay plain; desktop Mac without touch too", () => {
    assert.ok(href(env("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36", true)).startsWith("/api/ics?"));
    assert.ok(href(env(UA.iosSafari)).startsWith("/api/ics?"));
    assert.ok(href(env("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari/605.1.15", false, 0)).startsWith("/api/ics?"));
  });
  test("browser: iPhone Safari UA + window.TelegramWebviewProxy -> x-safari Apple link and the hint line", async () => {
    const e = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: UA.iosSafari });
    try {
      await e.context.addInitScript(() => { window.TelegramWebviewProxy = { postEvent() {} }; });
      await e.page.reload();
      await driveTo(e.page, "confirm", { contact: { name: "Звичайний" } });
      await e.page.click("#cta-confirm");
      await e.page.waitForSelector("#done-card", { state: "visible" });
      const apple = (await buttons(e.page.locator("#done-card"))).find((r) => r.k === "apple");
      assert.ok(apple.href.startsWith(`x-safari-${ORIGIN}/api/ics?`), apple.href);
      assert.equal(await e.page.getByText(uk.book.done.calendarIabHint).count(), 1);
      const hintPx = await e.page.getByText(uk.book.done.calendarIabHint).evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
      assert.equal(hintPx, 11, "the in-app hint uses the 11px caption style (t-body11), smaller than 12px body text");
    } finally {
      await e.context.close();
    }
  });
  test("browser: 360px in-app done screen (hint shown) does not scroll sideways and the hint stays inside the viewport", async () => {
    const e = await bookPage(browser, "oksana-ab12", { width: 360, userAgent: UA.iosSafari });
    try {
      await e.context.addInitScript(() => { window.TelegramWebviewProxy = { postEvent() {} }; });
      await e.page.reload();
      await driveTo(e.page, "confirm", { contact: { name: "Вузький" } });
      await e.page.click("#cta-confirm");
      await e.page.waitForSelector("#done-card", { state: "visible" });
      const hint = e.page.getByText(uk.book.done.calendarIabHint);
      assert.equal(await hint.count(), 1);
      const box = await hint.evaluate((n) => { const b = n.getBoundingClientRect(); return { w: b.width, right: b.right }; });
      assert.ok(box.w > 0 && box.right <= 360, JSON.stringify(box));
      const over = await e.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, `scrollWidth exceeds the viewport by ${over}px at 360px`);
    } finally {
      await e.context.close();
    }
  });
  for (const name of ["iosSafari", "androidInstagram", "iosTelegram"])
    test(`${name}: Apple href is the plain relative /api/ics link, no target, and no hint line`, async () => {
      const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: UA[name] });
      try {
        await driveTo(env.page, "confirm", { contact: { name: "Звичайний" } });
        await env.page.click("#cta-confirm");
        await env.page.waitForSelector("#done-card", { state: "visible" });
        const apple = (await buttons(env.page.locator("#done-card"))).find((r) => r.k === "apple");
        assert.ok(apple.href.startsWith("/api/ics?"), apple.href);
        assert.equal(apple.target, null);
        assert.equal(await env.page.getByText(uk.book.done.calendarIabHint).count(), 0);
      } finally {
        await env.context.close();
      }
    });
});

describe("master done screen at wider viewports", () => {
  for (const width of [768, 1280])
    test(`${width}px: the calendar buttons are visible and the page does not scroll sideways`, async () => {
      const env = await bookPage(browser, "oksana-ab12", { width, userAgent: UA.iosSafari });
      try {
        await driveTo(env.page, "confirm", { contact: { name: "Широкий" } });
        await env.page.click("#cta-confirm");
        await env.page.waitForSelector("#done-card", { state: "visible" });
        const rows = await env.page.locator("#done-card .calbtn").evaluateAll((as) => as.map((a) => { const b = a.getBoundingClientRect(); return { w: b.width, h: b.height, right: b.right }; }));
        assert.equal(rows.length, 2);
        for (const r of rows) assert.ok(r.w > 0 && r.h > 0 && r.right <= width, JSON.stringify(r));
        const over = await env.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `scrollWidth exceeds the viewport by ${over}px at ${width}px`);
      } finally {
        await env.context.close();
      }
    });
});

describe("salon done screen at wider viewports", () => {
  for (const width of [768, 1280])
    test(`${width}px: both calendar buttons per card are visible and the page does not scroll sideways`, async () => {
      const env = await salonPage(browser, `wiz-ics-wide-${width}`, { width }); // own slug per width: the mock keeps a booked (master, time) per slug
      try {
        await toConfirm(env.page, "501110031");
        await env.page.click("#cta-confirm");
        await env.page.waitForSelector("#done-list [data-done]", { state: "visible" });
        const rows = await env.page.locator("#done-list .calbtn").evaluateAll((as) => as.map((a) => { const b = a.getBoundingClientRect(); return { w: b.width, h: b.height, right: b.right }; }));
        assert.equal(rows.length, 4);
        for (const r of rows) assert.ok(r.w > 0 && r.h > 0 && r.right <= width, JSON.stringify(r));
        const over = await env.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(over <= 0, `scrollWidth exceeds the viewport by ${over}px at ${width}px`);
      } finally {
        await env.context.close();
      }
    });
});
