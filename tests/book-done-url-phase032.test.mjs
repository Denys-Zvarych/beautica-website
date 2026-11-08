// Phase 032: the done screen has its own URL (/c/{token}?n=1), that URL renders the confirmed view with calendar buttons from the token GET,
// and Instagram / Facebook iOS get no Apple button but a static line (their WKWebView blocks the x-safari hand-off).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open, mockCancelApi } from "./helpers/browser.mjs";
import { BASE, SHORT_TOKEN, uk, requireBase } from "./helpers/env.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const IG = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/24B119 Instagram 454.1.0.41.71 (iPhone15,4; iOS 27_2; en_GB; en-GB; scale=3.00; 1179x2556; IABMV/1; 1106185088) Safari/604.1";
const TG = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const tgProxy = `window.TelegramWebviewProxy = { postEvent() {} };`;

async function book(ua, init, tap, width = 393) {
  const env = await bookPage(browser, "oksana-ab12", { width, userAgent: ua, hasTouch: true, init });
  try {
    await driveTo(env.page, "confirm", { contact: { name: "Адреса", phone: "500000741" } });
    await env.page.click("#cta-confirm");
    await env.page.waitForSelector("#done-card", { state: "visible" });
    return await tap(env);
  } finally {
    await env.context.close();
  }
}

describe("done URL", () => {
  test("after booking: /c/{token}?n=1, state kept, and no history.replaceState hook (analytics) sees it", async () => {
    // An instance-level hook like Umami's: it must not be called for the token URL.
    const hook = `const o = history.replaceState.bind(history); window.__hooked = []; history.replaceState = (s, t, u) => { window.__hooked.push(String(u)); return o(s, t, u); };`;
    await book(TG, hook, async ({ page }) => {
      const { path, search, state, hooked } = await page.evaluate(() => ({ path: location.pathname, search: location.search, state: history.state, hooked: window.__hooked }));
      assert.match(path, /^\/(c\/[0-9A-Za-z]{16}|book\/cancel\/[0-9a-f-]{36})$/);
      assert.equal(search, "?n=1");
      assert.deepEqual(state, { bk: "done" });
      assert.ok(hooked.every((u) => !u.includes("/c/") && !u.includes("/book/cancel/")), `hooked calls: ${hooked}`);
      assert.equal(await page.locator("#done-card").isVisible(), true);
      assert.equal(await page.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer", "later requests do not carry the token URL as Referer");
    });
  });
});

describe("/c/{token}?n=1 confirmed view", () => {
  const INFO = {
    masterName: "Олена Коваль", serviceName: "Манікюр", startsAt: "2030-03-05T10:00:00Z", cancellable: true, windowClosesAt: "2030-03-05T08:00:00Z", status: "CONFIRMED",
    salonName: "Студія Лілія", address: "вул. Хрещатик, 1",
    items: [
      { bookingId: "11111111-1111-4111-8111-111111111111", serviceName: "Манікюр", startsAt: "2030-03-05T10:00:00Z", durationMinutes: 60, status: "CONFIRMED", cancellable: true },
      { bookingId: "22222222-2222-4222-8222-222222222222", serviceName: "Педикюр", startsAt: "2030-03-05T11:00:00Z", durationMinutes: 30, status: "CONFIRMED", cancellable: true },
    ],
  };
  async function view(query) {
    const env = await open(browser, { width: 393, height: 800 });
    const calls = await mockCancelApi(env.context, { get: () => ({ status: 200, json: INFO }) });
    try {
      await env.page.goto(`${BASE}/c/${SHORT_TOKEN}${query}`);
      await env.page.waitForSelector("#st-confirm", { state: "visible" });
      return { env, calls };
    } catch (e) {
      await env.context.close();
      throw e;
    }
  }

  test("calendar buttons built from the token GET (start, end = last service end, master, services, place, cancel link); heading; cancel button kept", async () => {
    const { env, calls } = await view("?n=1");
    try {
      const { page } = env;
      await page.waitForSelector("#c-cal .calbtn", { state: "visible" });
      assert.equal(await page.locator("h1").innerText(), uk.cancel.newTitle);
      assert.equal(await page.locator("#c-cal .calbtn").count(), 2);
      const apple = new URL(await page.locator('#c-cal [data-cal="apple"]').getAttribute("href"), BASE);
      assert.equal(apple.pathname, "/api/ics");
      assert.equal(apple.searchParams.get("s"), "20300305T100000Z".replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"));
      assert.equal(apple.searchParams.get("e"), "2030-03-05T11:30:00Z");
      assert.equal(apple.searchParams.get("t"), "Запис до Олена Коваль");
      assert.match(apple.searchParams.get("d"), /Манікюр, Педикюр/);
      assert.equal(apple.searchParams.get("l"), "Студія Лілія, вул. Хрещатик, 1");
      assert.equal(apple.searchParams.get("c"), SHORT_TOKEN);
      const g = new URL(await page.locator('#c-cal [data-cal="google"]').getAttribute("href"));
      assert.equal(g.searchParams.get("dates"), "20300305T100000Z/20300305T113000Z");
      for (const b of await page.locator("#c-cal .calbtn").all()) {
        const box = await b.boundingBox();
        assert.ok(box && box.width > 0 && box.height >= 48, "calendar button has a real box");
      }
      assert.equal(await page.getByRole("button", { name: /Скасувати/ }).first().isVisible(), true);
      assert.equal(calls.filter((c) => c.method === "GET").length, 1, "one token GET feeds summary and calendar");
    } finally {
      await env.context.close();
    }
  });

  for (const w of [360, 768, 1280])
    test(`${w}px: no horizontal scroll, calendar buttons visible with a real box`, async () => {
      const env = await open(browser, { width: w, height: 800 });
      await mockCancelApi(env.context, { get: () => ({ status: 200, json: INFO }) });
      try {
        await env.page.goto(`${BASE}/c/${SHORT_TOKEN}?n=1`);
        await env.page.waitForSelector("#c-cal .calbtn", { state: "visible" });
        assert.equal(await env.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        for (const b of await env.page.locator("#c-cal .calbtn").all()) assert.ok((await b.boundingBox()).width > 40);
      } finally {
        await env.context.close();
      }
    });

  test("without ?n=1: no calendar block, the cancel title as before", async () => {
    const { env } = await view("");
    try {
      assert.equal(await env.page.locator("#c-cal").isVisible(), false);
      assert.equal(await env.page.locator("#c-cal .calbtn").count(), 0);
      assert.notEqual(await env.page.locator("h1").innerText(), uk.cancel.newTitle);
    } finally {
      await env.context.close();
    }
  });
});

describe("Instagram / Facebook iOS: no Apple button, a static line", () => {
  test("Instagram: Google only (full row) and the static Safari line, no timed hint", async () => {
    await book(IG, undefined, async ({ page }) => {
      assert.equal(await page.locator('#done-card [data-cal="apple"]').count(), 0, "no Apple button");
      assert.equal(await page.locator('#done-card [data-cal="google"]').isVisible(), true);
      const hint = page.locator("[data-cal-hint=meta]");
      assert.equal(await hint.isVisible(), true, "visible at once");
      assert.equal((await hint.innerText()).trim(), uk.book.done.calendarMetaHint);
      assert.equal((await page.locator('#done-card [data-cal="google"]').boundingBox()).width > 250, true, "the single button takes the full row");
    });
  });
  test("Telegram iOS: Apple button kept, the static in-app line stays, no Meta line", async () => {
    await book(TG, tgProxy, async ({ page }) => {
      assert.equal(await page.locator("[data-cal-hint=meta]").count(), 0);
      assert.equal(await page.locator('#done-card [data-cal="apple"]').count(), 1);
      assert.equal(await page.getByText(uk.book.done.calendarIabHint).isVisible(), true);
    });
  });
  test("Safari iOS: both buttons, no hint", async () => {
    const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    await book(SAFARI, undefined, async ({ page }) => {
      assert.equal(await page.locator("#done-card .calbtn").count(), 2);
      assert.equal(await page.locator("#done-card .calhint").count(), 0);
    });
  });
});

describe("analytics beacons never see the token URL", () => {
  // The REAL Cloudflare beacon (it hooks history + the Navigation API and reports the page URL on load / navigation / pagehide). Served from the network by the test itself
  // (the page's request is answered locally, nothing leaves the browser); without network the test is skipped, never green by default.
  let beacon = null;
  before(async () => {
    try {
      const res = await fetch("https://static.cloudflareinsights.com/beacon.min.js", { signal: AbortSignal.timeout(15000) });
      if (res.ok) beacon = await res.text();
    } catch {
      /* offline */
    }
  });
  test("after booking, and after leaving the page: no request to Cloudflare Insights / Umami carries /c/, /book/cancel/ or the token", async (t) => {
    if (!beacon) return t.skip("beacon.min.js not reachable (offline)");
    const env = await bookPage(browser, "oksana-ab12", { width: 393, userAgent: TG, hasTouch: true, init: tgProxy });
    const seen = [];
    const record = (r) => seen.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`);
    await env.context.route("https://static.cloudflareinsights.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: beacon }));
    await env.context.route((u) => u.hostname.endsWith("cloudflareinsights.com") && u.hostname !== "static.cloudflareinsights.com", (r) => {
      record(r.request());
      return r.fulfill({ status: 204, body: "" });
    });
    await env.context.route((u) => /umami\.is$/.test(u.hostname) && u.hostname !== "cloud.umami.is", (r) => {
      record(r.request());
      return r.fulfill({ status: 204, body: "" });
    });
    try {
      await env.page.reload({ waitUntil: "load" });
      await env.page.clock.runFor(8000); // Umami at +1.5 s, the beacon in the next idle slot
      await env.page.waitForFunction(() => !!window.__cfBeacon || !!document.querySelector("script[data-cf-beacon]"));
      await driveTo(env.page, "confirm", { contact: { name: "Адреса", phone: "500000741" } });
      await env.page.click("#cta-confirm");
      await env.page.waitForSelector("#done-card", { state: "visible" });
      assert.match(new URL(env.page.url()).pathname, /^\/(c\/|book\/cancel\/)/, "the address was switched");
      await env.page.clock.runFor(5000);
      await env.page.goto(`${BASE}/`, { waitUntil: "load" }); // real pagehide: the beacon flushes its page-view / performance data here
      await env.page.waitForTimeout(500);
      assert.ok(seen.length > 0, "the beacon reported at least once (otherwise this test proves nothing)");
      const leak = seen.filter((s) => /\/c\/|\/book\/cancel\/|[0-9A-Za-z]{16}\?n=1|[?&]n=1/.test(s));
      assert.deepEqual(leak, [], `token URL reached an analytics endpoint:\n${leak.join("\n")}`);
    } finally {
      await env.context.close();
    }
  });
});

const oneLine = (page, scope) =>
  page.evaluate((sel) => [...document.querySelectorAll(`${sel} .calbtn .t-strong115`)].map((e) => ({ text: e.textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)), fits: e.scrollWidth <= e.clientWidth, pillFits: e.parentElement.scrollWidth <= e.parentElement.clientWidth })), scope);

describe("/c/{token}?n=1 layout does not move when the calendar buttons arrive", () => {
  const INFO = {
    masterName: "Олена Коваль", serviceName: "Манікюр", startsAt: "2030-03-05T10:00:00Z", cancellable: true, windowClosesAt: "2030-03-05T08:00:00Z", status: "CONFIRMED",
    items: [{ bookingId: "11111111-1111-4111-8111-111111111111", serviceName: "Манікюр", startsAt: "2030-03-05T10:00:00Z", durationMinutes: 60, status: "CONFIRMED", cancellable: true }],
  };
  // Default UA, and Instagram on iOS (the real block has the static Safari line under the single Google button: the placeholder must hold its space too).
  for (const [name, opts] of [["default UA", {}], ["Instagram iOS", { userAgent: IG, hasTouch: true }]])
    test(`360px, ${name}: the cancel button keeps its top from the first confirm render to the buttons`, async () => {
      const env = await open(browser, { width: 360, height: 800, ...opts });
      await mockCancelApi(env.context, { get: () => ({ status: 200, json: INFO }) });
      // Every frame records the cancel button's top while the confirm state is on screen: it must be ONE value from the first confirm render on (placeholder -> real buttons).
      await env.context.addInitScript(() => {
        window.__tops = new Set();
        const tick = () => {
          const b = document.getElementById("c-confirm");
          if (b && b.offsetParent) window.__tops.add(b.getBoundingClientRect().top);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      try {
        await env.page.goto(`${BASE}/c/${SHORT_TOKEN}?n=1`);
        await env.page.waitForSelector("#st-confirm", { state: "visible" });
        const calBox = await env.page.locator("#c-cal").boundingBox();
        assert.ok(calBox && calBox.height > 40, "the block is reserved in the HTML at (about) its final height");
        await env.page.waitForSelector("#c-cal .calbtn", { state: "visible" });
        await env.page.waitForTimeout(300);
        assert.equal(await env.page.evaluate(() => window.__tops.size), 1, "the cancel button never moved");
        assert.equal(await env.page.locator("[data-cal-hint=meta]").count(), name === "Instagram iOS" ? 1 : 0);
      } finally {
        await env.context.close();
      }
    });
});

describe("calendar labels stay on one line and inside their pill at 320 and 360px", () => {
  const INFO = { masterName: "Олена Коваль", serviceName: "Манікюр", startsAt: "2030-03-05T10:00:00Z", cancellable: true, windowClosesAt: "2030-03-05T08:00:00Z", status: "CONFIRMED", items: [{ bookingId: "11111111-1111-4111-8111-111111111111", serviceName: "Манікюр", startsAt: "2030-03-05T10:00:00Z", durationMinutes: 60, status: "CONFIRMED", cancellable: true }] };
  const expectFit = (labels, w) => {
    assert.ok(labels.length >= 1);
    for (const l of labels) assert.deepEqual({ oneLine: l.lines === 1 || (w === 320 && l.lines === 2), fits: l.fits, pillFits: l.pillFits }, { oneLine: true, fits: true, pillFits: true }, `${l.text}: ${l.lines} line(s), inside its pill`);
  };
  for (const w of [320, 360]) {
    test(`/c/{token}?n=1 at ${w}px: both labels on one line, no overflow, 48px targets, no horizontal scroll`, async () => {
      const env = await open(browser, { width: w, height: 800 });
      await mockCancelApi(env.context, { get: () => ({ status: 200, json: INFO }) });
      try {
        await env.page.goto(`${BASE}/c/${SHORT_TOKEN}?n=1`);
        await env.page.waitForSelector("#c-cal .calbtn", { state: "visible" });
        const labels = await oneLine(env.page, "#c-cal");
        assert.equal(labels.length, 2);
        expectFit(labels, w);
        for (const b of await env.page.locator("#c-cal .calbtn").all()) assert.ok((await b.boundingBox()).height >= 48);
        assert.equal(await env.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      } finally {
        await env.context.close();
      }
    });
    test(`/book done step at ${w}px: both labels on one line, no overflow`, async () => {
      await book(undefined, undefined, async ({ page }) => {
        const labels = await oneLine(page, "#done-card");
        assert.equal(labels.length, 2);
        expectFit(labels, w);
      }, w);
    });
  }
});

// QA gap-fill (phase 032): the iOS UAs at the narrowest width. The Meta hint adds a line, Telegram keeps the Apple button: neither may overflow at 320px.
describe("/book done step at 320px per iOS user agent: no horizontal overflow, buttons keep a real box", () => {
  const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const noOverflow = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth <= innerWidth, card: (() => { const c = document.getElementById("done-card"); return c.scrollWidth <= c.clientWidth; })() }));
  const boxes = async (page) => {
    const out = [];
    for (const b of await page.locator("#done-card .calbtn").all()) out.push(await b.boundingBox());
    return out;
  };
  for (const [name, ua, init, apple, hint] of [
    ["Safari iOS", SAFARI, undefined, 1, null],
    ["Telegram iOS", TG, tgProxy, 1, "calendarIabHint"],
    ["Instagram iOS", IG, undefined, 0, "calendarMetaHint"],
  ])
    test(`${name}: ${apple ? "Apple + Google" : "Google only"}, ${hint ? "static line visible, " : "no line, "}no overflow`, async () => {
      await book(ua, init, async ({ page }) => {
        assert.equal(await page.locator('#done-card [data-cal="apple"]').count(), apple, apple ? "Apple button kept" : "no Apple button");
        assert.equal(await page.locator('#done-card [data-cal="google"]').isVisible(), true);
        const bs = await boxes(page);
        assert.equal(bs.length, apple + 1);
        for (const b of bs) assert.ok(b && b.width > 40 && b.height >= 48 && b.x >= 0 && b.x + b.width <= 320, `inside the 320px viewport: ${JSON.stringify(b)}`);
        if (hint) assert.equal(await page.getByText(uk.book.done[hint]).isVisible(), true);
        else assert.equal(await page.locator("#done-card .calhint").count(), 0);
        assert.deepEqual(await noOverflow(page), { doc: true, card: true });
      }, 320);
    });
});
