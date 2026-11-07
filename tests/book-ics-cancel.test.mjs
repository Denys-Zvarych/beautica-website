// Phase 030 QA: the cancel link in «Додати в календар» on BOTH done screens (master + salon): Google details line, Apple c= token and the .ics it returns, the Google link's
// rel/target (the bearer token must not leak via Referer), the 500-char cap that never cuts the cancel line, and the iOS in-app hint only where it belongs.
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

describe("the cancel line survives the 500-character Google details cap", () => {
  const ev = { startsAt: "2026-11-08T12:00:00Z", minutes: 60, title: "Запис", location: "" };
  for (const [name, url] of [["short token", "https://beautica.app/c/Ab3dEf7hJk9mNp2Q"], ["legacy uuid token", CANCEL_URL]])
    test(`${name}: 40 very long services -> details is <= 500, the services text is cut with an ellipsis, the line is whole at the end`, () => {
      const description = "Послуги: " + Array.from({ length: 40 }, (_, i) => `Надзвичайно довга назва послуги ${i}`).join(", ");
      const d = new URL(calendarLinks({ ...ev, description, cancel: { url, label: uk.book.ics.cancel } }).google).searchParams.get("details");
      const line = `${uk.book.ics.cancel}: ${url}`;
      assert.ok(d.length <= 500, String(d.length));
      assert.ok(d.endsWith(`…\n${line}`), d);
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
