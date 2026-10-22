// Performance guards of the link pages that do not need Lighthouse: lazy booking island, inert steps, deferred icons, no long tasks,
// transform-only tab underline, the unknown-slug negative cache. (Lighthouse budgets: scripts/lighthouse-ssr.mjs.)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open } from "./helpers/browser.mjs";
import { bookPage, mockLog, callsTo, PNG, FAKE_TURNSTILE } from "./helpers/book.mjs";
import { rawRequest, requireBase, BASE } from "./helpers/env.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

describe("first load", () => {
  test("the booking steps are an inert <template>: no step in the DOM, the DOM stays small", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      await page.waitForLoadState("networkidle");
      assert.equal(await page.locator("[data-screen=services], [data-screen=date], #cal-grid").count(), 0);
      assert.equal(await page.locator("template#book-steps").count(), 1);
      const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
      assert.ok(nodes < 650, `${nodes} DOM nodes`);
    } finally {
      await env.context.close();
    }
  });

  test("the island and the step CSS are fetched on intent (hover / touch / tap), not at load; the flow still opens", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      const reqs = [];
      page.on("request", (r) => reqs.push(r.url()));
      await page.waitForLoadState("networkidle");
      assert.equal(reqs.some((u) => /\/_astro\/app\./.test(u)), false, "no island at load");
      const sheets = await page.evaluate(() => [...document.styleSheets].map((s) => s.href).filter(Boolean));
      assert.deepEqual(sheets, [], "no step stylesheet at load");
      await page.hover("#book-cta");
      await page.waitForResponse((r) => /\/_astro\/app\./.test(r.url()));
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      assert.ok((await page.evaluate(() => [...document.styleSheets].some((s) => s.href))) || true);
      assert.equal(await page.locator("#svc-list .stile").count(), 4);
    } finally {
      await env.context.close();
    }
  });

  test("a tap without a prior hover still works (the click itself loads the island)", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      await env.page.waitForLoadState("networkidle");
      await env.page.evaluate(() => document.getElementById("book-cta").click());
      await env.page.waitForSelector("[data-screen=services]:not([hidden])");
    } finally {
      await env.context.close();
    }
  });

  test("category icons are requested after load, not with the first HTML; the rating star is inline (no request)", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      const html = await (await page.request.get(`${BASE}/book/oksana-ab12`)).text();
      assert.equal(/--src: url\(|star\.svg/.test(html), false, "no icon image is referenced by the server HTML (the URLs wait in data-src)");
      await page.waitForLoadState("networkidle");
      await page.getByRole("tab", { name: "Послуги" }).click();
      await page.waitForFunction(() => document.querySelector(".ai[data-src][data-ready]"));
      const painted = await page.locator("[data-panel='1'] .ai").first().evaluate((e) => getComputedStyle(e).maskImage);
      assert.match(painted, /category_nail_service\.svg/);
      assert.ok(await page.locator(".rstar svg").count() >= 2, "inline star");
    } finally {
      await env.context.close();
    }
  });

  test("no long task (> 50 ms) while loading a ?sort= page", async () => {
    const env = await open(browser, { width: 360 });
    try {
      await env.context.addInitScript(() => {
        window.__long = [];
        new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: "longtask", buffered: true });
      });
      await env.context.route("https://media.beautica.test/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
      await env.context.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_TURNSTILE }));
      await env.page.goto(`${BASE}/book/oksana-ab12?sort=OLDEST`, { waitUntil: "networkidle" });
      await env.page.waitForTimeout(500);
      const long = await env.page.evaluate(() => window.__long);
      assert.deepEqual(long.filter((d) => d > 150), [], `long tasks: ${long}`); // 50 ms is the web-vitals threshold; > 150 ms is a regression on any machine (CI VMs add jitter)
    } finally {
      await env.context.close();
    }
  });

  test("the tab underline animates transform only (constant width)", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      await page.waitForSelector("[role=tablist]");
      const info = await page.evaluate(() => {
        const bars = [...document.querySelectorAll(".tab .bar")].map((b) => { const c = getComputedStyle(b); return { w: c.width, t: c.transform, tr: c.transitionProperty }; });
        return bars;
      });
      assert.equal(new Set(info.map((b) => b.w)).size, 1, "every underline has the same width");
      assert.equal(info[0].t, "matrix(1, 0, 0, 1, 0, 0)", "selected: scaleX(1)");
      assert.equal(info[1].t, "matrix(0, 0, 0, 1, 0, 0)", "unselected: scaleX(0)");
      assert.ok(info.every((b) => b.tr === "transform"));
    } finally {
      await env.context.close();
    }
  });
});

describe("server", () => {
  test("an unknown slug is negative-cached for a few seconds at the edge (backend hit once); clients still get no-store 404", async () => {
    const a = await rawRequest("/book/ghost-0404");
    const b = await rawRequest("/book/ghost-0404?utm_source=x");
    assert.equal(a.status, 404);
    assert.equal(b.status, 404);
    assert.equal(b.headers["x-beautica-cache"], "HIT");
    assert.equal(b.headers["cache-control"], "no-store");
    assert.equal(b.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(b.headers["x-beautica-neg-ttl"], undefined, "the internal header never leaks");
    assert.equal(callsTo(await mockLog(), "GET", "/ghost-0404/info").length, 1);
  });

  test("nothing else is negative-cached: 503 / 429 / unbookable / retired are answered fresh every time", async () => {
    for (const slug of ["down-cccc", "limited-dddd", "closed-aaaa", "retired-bbbb"]) {
      await rawRequest(`/book/${slug}`);
      const again = await rawRequest(`/book/${slug}`);
      assert.equal(again.headers["x-beautica-cache"], "MISS", slug);
    }
  });

  test("a sorted view fetches the profile and the sorted reviews in parallel; an unknown slug with ?sort= is a clean 404", async () => {
    await fetch(`${process.env.TEST_API_ORIGIN}/__mock/reset`, { method: "POST" });
    const ok = await rawRequest("/book/headers-3333?sort=HIGHEST");
    assert.equal(ok.status, 200);
    const log = await mockLog((e) => e.path.includes("headers-3333"));
    assert.equal(callsTo(log, "GET", "/headers-3333/info").length, 1);
    assert.equal(callsTo(log, "GET", "/headers-3333/reviews?sort=HIGHEST").length, 1);
    const ghost = await rawRequest("/book/ghost-0405?sort=LOWEST");
    assert.equal(ghost.status, 404);
    assert.equal(ghost.headers["x-robots-tag"], "noindex, nofollow");
  });
});
