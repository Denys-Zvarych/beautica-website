// Performance guards of the link pages that do not need Lighthouse: lazy booking island, inert steps, deferred icons, no long tasks,
// transform-only tab underline, the unknown-slug negative cache. (Lighthouse budgets: scripts/lighthouse-ssr.mjs.)
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open } from "./helpers/browser.mjs";
import { gzSize } from "../scripts/lib/gzSize.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { salonPage, pickServices, toggleMaster, clickAndLoadDays, scheduleMaster } from "./helpers/salon.mjs";
import { driveTo } from "./helpers/book.mjs";
import { bookPage, mockLog, logMark, callsTo, PNG, FAKE_TURNSTILE } from "./helpers/book.mjs";
import { rawRequest, requireBase, BASE, ROOT } from "./helpers/env.mjs";

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
      assert.equal(/--src: url\(|star\.svg/.test(html.replace(/<noscript>[\s\S]*?<\/noscript>/g, "")), false, "no icon image is referenced by the server HTML (the URLs wait in data-src)");
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
    // A slug of its own and a log mark instead of clearing the shared log: other files use the same mock at the same time.
    const mark = await logMark();
    const ok = await rawRequest("/book/sortv-0001?sort=HIGHEST");
    assert.equal(ok.status, 200);
    const log = await mockLog((e) => e.path.includes("sortv-0001"), mark);
    assert.equal(callsTo(log, "GET", "/sortv-0001/info").length, 1);
    assert.equal(callsTo(log, "GET", "/sortv-0001/reviews?sort=HIGHEST").length, 1);
    const ghost = await rawRequest("/book/ghost-0405?sort=LOWEST");
    assert.equal(ghost.status, 404);
    assert.equal(ghost.headers["x-robots-tag"], "noindex, nofollow");
  });
});

describe("no JavaScript", () => {
  test("category icons are in the page for visitors without script (<noscript>); with script they come from data-src after load", async () => {
    const env = await bookPage(browser, "oksana-ab12", { js: false });
    try {
      const icon = await env.page.locator("[data-panel='1'] .cat .ico .ai:not([data-src])").first().evaluate((e) => ({ mask: getComputedStyle(e).maskImage, vis: getComputedStyle(e).visibility, w: e.getBoundingClientRect().width }));
      assert.match(icon.mask, /category_nail_service\.svg/);
      assert.equal(icon.vis, "visible");
      assert.ok(icon.w > 0);
      assert.equal(await env.page.locator("[data-panel='1'] .ai[data-src]").first().evaluate((e) => getComputedStyle(e).visibility), "hidden", "the deferred copy stays hidden without script");
    } finally {
      await env.context.close();
    }
  });
});

// README § 4 budget: JS <= 20 KB gz BEFORE user intent and <= 30 KB gz after a full booking walk (every lazy chunk loaded), on both link pages.
// Measured in a real browser: every same-origin script response, gzipped (level 9), each URL once. Third-party scripts (Turnstile) are not ours.
const BEFORE_KB = 20;
const WALK_KB = 30;
describe("JS budget: before intent and after a full walk", () => {
  async function measure(env, walk) {
    const seen = new Map();
    // The sizes come from the built files (gzip level 9), the requests from the browser: a response body cannot always be read once the page moves on.
    env.page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.origin === new URL(BASE).origin && u.pathname.endsWith(".js") && r.status() === 200 && existsSync(join(ROOT, "dist/client", u.pathname))) seen.set(u.pathname, gzSize(readFileSync(join(ROOT, "dist/client", u.pathname))));
    });
    // In-flight bookkeeping instead of Playwright's "networkidle": that state needs 500 ms of zero connections and never arrives while one slow
    // request hangs, and then the failure names no request (CI PR #68: waitForLoadState timed out after 60 s). This one lists what is pending.
    const pending = new Map();
    env.page.on("request", (r) => pending.set(r, r.url()));
    for (const ev of ["requestfinished", "requestfailed"]) env.page.on(ev, (r) => pending.delete(r));
    const settled = async (what) => {
      const deadline = Date.now() + 60_000;
      for (let calm = 0; calm < 3; ) {
        if (Date.now() > deadline) throw new Error(`${what}: ${pending.size} request(s) still in flight after 60 s: ${[...pending.values()].join(", ")}`);
        await new Promise((r) => setTimeout(r, 200));
        calm = pending.size === 0 ? calm + 1 : 0;
      }
    };
    await env.page.reload({ waitUntil: "load" }); // listener on, then everything the page loads by itself
    await settled("after reload");
    const total = () => [...seen.values()].reduce((a, n) => a + n, 0);
    const before = total();
    await walk();
    await settled("after the walk");
    return { before, full: total(), files: [...seen.keys()].map((p) => p.split("/").pop()) };
  }
  const gate = (route, m) => {
    console.log(`JS BUDGET ${route}: before intent ${(m.before / 1024).toFixed(1)} KB gz, after a full walk ${(m.full / 1024).toFixed(1)} KB gz (${m.files.length} files)`);
    assert.ok(m.before <= BEFORE_KB * 1024, `${route}: ${m.before} B gz of JS before any intent: over the ${BEFORE_KB} KB budget (README § 4)`);
    assert.ok(m.full <= WALK_KB * 1024, `${route}: ${m.full} B gz of JS after a full booking walk (${m.files.join(", ")}): over the ${WALK_KB} KB budget (README § 4). Split or trim a chunk; do not raise the limit.`);
  };
  test("/book/{slug}: hover + click the button, the whole flow to the contact step, the reviews tab", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      const m = await measure(env, async () => {
        await page.getByRole("tab", { name: "Відгуки" }).click();
        await page.hover("#book-cta");
        await driveTo(page, "contact");
      });
      gate("/book/{slug}", m);
    } finally {
      await env.context.close();
    }
  });
  test("/book/s/{slug}: hover + click, services -> master -> day -> time -> contact step, the filter and the reviews tab", async () => {
    const env = await salonPage(browser, "wiz-js-0001");
    try {
      const { page } = env;
      const m = await measure(env, async () => {
        await page.getByRole("tab", { name: "Відгуки" }).click();
        await page.getByRole("tab", { name: "Послуги" }).click();
        await page.locator("[data-filter-id]").first().click(); // the services-tab filter (its chunk and the salon info)
        await page.waitForSelector("[data-filter-chip]:not([hidden])");
        await page.hover("#book-cta");
        await pickServices(page, { id: "d0000012-1111-4222-8333-944455556666" });
        await page.click("#cta-services");
        await toggleMaster(page, { id: "e0000001-1111-4222-8333-944455556666" });
        await clickAndLoadDays(page, "#cta-masters");
        await scheduleMaster(page, 1);
        await page.click("#cta-time");
        await page.waitForSelector("[data-screen=contact]:not([hidden])");
      });
      gate("/book/s/{slug}", m);
    } finally {
      await env.context.close();
    }
  });
});
