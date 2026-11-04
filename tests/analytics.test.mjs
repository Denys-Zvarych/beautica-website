// Phase 007 QA: the analytics loader and the event queue in a real browser, against `wrangler dev` (scripts/run-tests.mjs).
// Both third-party scripts are answered locally (nothing leaves the machine): Umami by a stub that records track() calls in window.__sent,
// the Cloudflare beacon by an empty script. Time-based assertions use Playwright's fake clock (runFor), so there is no fixed sleep; the one
// real-time test waits on the request itself and compares timestamps.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open, mockCancelApi } from "./helpers/browser.mjs";
import { bookPage, pickableDay } from "./helpers/book.mjs";
import { BASE, TOKEN, SHORT_TOKEN, requireBase } from "./helpers/env.mjs";
import { UMAMI_SCRIPT_SRC, UMAMI_HOST_URL, UMAMI_WEBSITE_ID, UMAMI_DOMAINS, CF_BEACON_SRC, CF_BEACON_TOKEN } from "../src/config/analytics.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const UMAMI_STUB = "window.umami={track:function(e,p){(window.__sent=window.__sent||[]).push([e,p]);}};";
const isTag = (u) => u.href === UMAMI_SCRIPT_SRC || u.href === CF_BEACON_SRC;
const sent = (page) => page.evaluate(() => window.__sent ?? []);

/** Answers both tags locally and records [url, ms since epoch] of each request. `umami`: "stub" | "error". */
async function stubTags(context, { umami = "stub", beforeUmami } = {}) {
  const hits = [];
  await context.route(isTag, async (route) => {
    const url = route.request().url();
    hits.push({ url, at: Date.now() });
    if (url === UMAMI_SCRIPT_SRC) await beforeUmami?.();
    if (url === UMAMI_SCRIPT_SRC) return umami === "stub" ? route.fulfill({ status: 200, contentType: "text/javascript", body: UMAMI_STUB }) : route.abort("failed");
    return route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
  });
  return hits;
}

describe("loader timing and attributes on public pages", () => {
  for (const path of ["/", "/privacy"]) {
    test(`${path}: no analytics request before the 1.5 s delay (fake clock); then Umami and the beacon with the documented attributes`, async () => {
      const { context, page } = await open(browser);
      try {
        const hits = await stubTags(context);
        await page.clock.install({ time: 0 }); // controlled clock: the 1.5 s delay is stepped, never waited for
        await page.clock.pauseAt(1000); // frozen from page start: a slow load under CI cannot let real time run the 1.5 s timer
        await page.goto(BASE + path, { waitUntil: "load" });
        assert.equal(await page.locator("script[data-website-id], script[data-cf-beacon]").count(), 0, "no tag at load time");
        await page.clock.runFor(1400);
        assert.deepEqual(hits, [], "nothing requested before the 1.5 s delay");
        assert.equal(await page.locator("script[data-website-id]").count(), 0, "no Umami tag at 1.4 s");
        await page.clock.runFor(6000); // past the delay, the idle slot and the beacon's slot
        await page.clock.resume(); // real time again: the idle slot and the stub responses need it
        await page.waitForFunction(() => document.querySelector("script[data-cf-beacon]")); // condition, not a sleep
        await expectEventually(() => hits.length, 2, "both analytics requests recorded"); // the tag element is injected before its request is routed
        assert.deepEqual(hits.map((h) => h.url), [UMAMI_SCRIPT_SRC, CF_BEACON_SRC], "Umami first, the beacon in its own later slot");
        assert.ok(hits[1].at >= hits[0].at);
        const attr = (sel, name) => page.locator(sel).getAttribute(name);
        assert.equal(await attr("script[data-website-id]", "data-website-id"), UMAMI_WEBSITE_ID);
        assert.equal(await attr("script[data-website-id]", "data-host-url"), UMAMI_HOST_URL);
        assert.equal(await attr("script[data-website-id]", "data-domains"), UMAMI_DOMAINS);
        assert.equal(await attr("script[data-website-id]", "data-exclude-search"), "true");
        assert.equal(await attr("script[data-website-id]", "data-exclude-hash"), "true");
        assert.deepEqual(JSON.parse(await attr("script[data-cf-beacon]", "data-cf-beacon")), { token: CF_BEACON_TOKEN });
      } finally {
        await context.close();
      }
    });
  }
});

describe("token routes and malformed token paths: no marker, no tag, no request even after 10 s", () => {
  const MALFORMED = ["/book/cancel/a/b", `/book/cancel/${TOKEN}/extra`, "/c/a/b", `/c/${SHORT_TOKEN}/extra`, "/invite/x/y", "/bookings/x/y", "/l/nothing"];
  const PATHS = [`/bookings/${TOKEN}`, `/bookings/${TOKEN}/review`, "/invite/accept?token=abc123", `/book/cancel/${TOKEN}`, `/c/${SHORT_TOKEN}`, "/l/booking", "/l/cancel", ...MALFORMED];
  for (const path of PATHS) {
    test(`${path.replace(TOKEN, ":id").replace(SHORT_TOKEN, ":short")}: nothing requested`, async () => {
      const { context, page, analytics } = await open(browser);
      try {
        await mockCancelApi(context, { get: () => ({ status: 404 }) });
        const hits = await stubTags(context);
        await page.clock.install();
        await page.goto(BASE + path, { waitUntil: "load" });
        await page.clock.runFor(10_000); // past the 1.5 s delay, the idle slot and its 3 s timeout, and the beacon's slot
        assert.deepEqual(hits, []);
        assert.deepEqual(analytics, []);
        assert.equal(await page.locator("script[data-website-id], script[data-cf-beacon]").count(), 0);
        // Real token pages render no marker at all; the shared 404 page under a malformed token path still has it, and the loader refuses there (no request above).
        if (!MALFORMED.includes(path)) assert.equal(await page.locator("meta[name=beautica-analytics]").count(), 0);
      } finally {
        await context.close();
      }
    });
  }
});

describe("link_open on a booking link survives the delayed load", () => {
  test("/book/{slug}?s=s: queued at load, not sent before Umami exists, delivered with channel + referrer host once the stub loads", async () => {
    const { context, page } = await bookPageWithClock("oksana-ab12", "?s=s", "https://instagram.com/some/path?x=1");
    try {
      await page.clock.runFor(1400);
      assert.equal(await page.evaluate(() => typeof window.umami), "undefined", "Umami is not loaded before the delay");
      await page.clock.runFor(6000);
      await page.waitForFunction(() => (window.__sent ?? []).length > 0);
      assert.deepEqual(await sent(page), [
        ["link_open", { referrer_host: "instagram.com", kind: "master", source: "share" }],
        ["profile_view", { slug: "oksana-ab12", kind: "master", source: "share" }],
      ]);
      assert.equal(new URL(page.url()).search, "", "the ?s flag is removed from the address bar");
    } finally {
      await context.close();
    }
  });

  test("/book/{slug} without a flag: source none, empty referrer host", async () => {
    const { context, page } = await bookPageWithClock("oksana-ab12", "", undefined);
    try {
      await page.clock.runFor(8000);
      await page.waitForFunction(() => (window.__sent ?? []).length > 0);
      assert.deepEqual(await sent(page), [
        ["link_open", { referrer_host: "", kind: "master", source: "none" }],
        ["profile_view", { slug: "oksana-ab12", kind: "master", source: "none" }],
      ]);
    } finally {
      await context.close();
    }
  });

  test("Umami load error: the queue is dropped (even though window.umami exists at that moment), nothing throws, a late success event replays nothing", async () => {
    // window.umami is made visible just before the script request fails, so a regression that FLUSHES on error (or keeps the queue for later) would send link_open.
    let page;
    const env = await bookPageWithClock("oksana-ab12", "?s=c", undefined, { umami: "error", beforeUmami: () => page.evaluate(() => (window.__ready = true)), init: true });
    page = env.page;
    const { context, pageErrors } = env;
    try {
      await page.clock.runFor(8000);
      await page.waitForFunction(() => document.querySelector("script[data-website-id]"));
      await page.clock.runFor(8000);
      await page.waitForFunction(() => document.querySelector("script[data-cf-beacon]")); // the beacon slot follows the error event
      assert.equal(await page.evaluate(() => typeof window.umami), "object");
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("beautica:umami", { detail: true }))); // a late announcement
      assert.deepEqual(await sent(page), [], "the dropped queue is neither flushed on error nor replayed later");
      assert.deepEqual(pageErrors, [], "a failed analytics script must not throw");
    } finally {
      await context.close();
    }
  });

  test("after Umami loaded, later funnel events are sent directly (service_selected, slot_selected) with the channel merged in", async () => {
    const { context, page } = await bookPageWithClock("oksana-ab12", "?s=c", undefined);
    try {
      await page.clock.runFor(8000);
      await page.waitForFunction(() => (window.__sent ?? []).length > 0);
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      await page.click("#svc-list [data-id]");
      await page.waitForFunction(() => (window.__sent ?? []).some((e) => e[0] === "service_selected"));
      const events = await sent(page);
      assert.deepEqual(events.map((e) => e[0]), ["link_open", "profile_view", "service_selected"]);
      assert.deepEqual(events[2][1], { count: 1, kind: "master", source: "copy" });
      await page.click("#cta-services");
      await page.click(`[data-day="${await pickableDay(page)}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      await page.locator("#slots .slot").first().click();
      await page.waitForFunction(() => (window.__sent ?? []).some((e) => e[0] === "slot_selected"));
      const slot = (await sent(page)).find((e) => e[0] === "slot_selected");
      assert.deepEqual(Object.keys(slot[1]).sort(), ["days_ahead", "kind", "source"]);
      assert.ok(Number.isInteger(slot[1].days_ahead) && slot[1].days_ahead >= 0);
    } finally {
      await context.close();
    }
  });
});

/** Polls (condition, not a sleep) until `read()` equals `want`; the final failure shows the last value. */
async function expectEventually(read, want, msg, ms = 15_000) {
  const end = Date.now() + ms;
  while (read() !== want && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.equal(read(), want, msg);
}

/** Opens a booking-link page with the fake clock installed BEFORE navigation and the tags answered locally. */
async function bookPageWithClock(slug, query, referer, tagOpts) {
  const env = await open(browser);
  if (tagOpts?.init) await env.context.addInitScript(`Object.defineProperty(window,"umami",{configurable:true,get:function(){return window.__ready?{track:function(e,p){(window.__sent=window.__sent||[]).push([e,p]);}}:undefined}});`);
  await mockMedia(env.context);
  await stubTags(env.context, tagOpts);
  const pageErrors = [];
  env.page.on("pageerror", (e) => pageErrors.push(e.message));
  await env.page.clock.install();
  await env.page.goto(`${BASE}/book/${slug}${query}`, { waitUntil: "load", ...(referer ? { referer } : {}) });
  return { ...env, pageErrors };
}
async function mockMedia(context) {
  await context.route("https://media.beautica.test/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) }));
  await context.route("https://challenges.cloudflare.com/**", (r) => r.abort("failed"));
}

describe("no cookies, ever", () => {
  for (const path of ["/", "/privacy", "/book/oksana-ab12"]) {
    test(`${path}: no Set-Cookie header, no cookie in the jar or document.cookie after interactions and after the analytics scripts ran`, async () => {
      const { context, page } = await open(browser);
      const setCookie = [];
      page.on("response", async (r) => {
        const h = await r.allHeaders();
        if (h["set-cookie"]) setCookie.push(r.url());
      });
      try {
        await mockMedia(context);
        const hits = await stubTags(context);
        await page.goto(BASE + path, { waitUntil: "load" });
        await page.waitForFunction(() => document.querySelector("script[data-cf-beacon]")); // analytics fully injected
        await expectEventually(() => hits.length, 2, "both analytics requests recorded"); // the tag element appears before its request is routed
        if (path === "/privacy") {
          await page.locator("details.toc-details summary").click().catch(() => {}); // contents list is a <details> on phones
          await page.keyboard.press("End");
        } else if (path === "/") {
          await page.keyboard.press("Tab");
          await page.keyboard.press("End");
        } else {
          await page.click("#book-cta");
          await page.waitForSelector("[data-screen=services]:not([hidden])");
          await page.click("#svc-list [data-id]");
          await page.click("#cta-services");
          await page.click(`[data-day="${await pickableDay(page)}"]`);
        }
        assert.deepEqual(await context.cookies(), [], "cookie jar");
        assert.equal(await page.evaluate(() => document.cookie), "");
        assert.deepEqual(setCookie, [], "responses with Set-Cookie");
      } finally {
        await context.close();
      }
    });
  }
});
