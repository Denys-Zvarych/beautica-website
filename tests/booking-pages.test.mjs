// Phase 008: the SSR link pages /book/{slug} and /book/s/{slug} against the mock backend (tests/helpers/mock-api.mjs).
// States, first-HTML content (no JS), SEO + JSON-LD, headers, edge cache, forwarded headers, no leaks, rendering at 360/768/1280.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rawRequest, requireBase, freshIp, BASE, MOCK_API } from "./helpers/env.mjs";
import { launch } from "./helpers/browser.mjs";
import { bookPage, mockLog, callsTo, shot } from "./helpers/book.mjs";
import { visibleBox } from "./helpers/browser.mjs";

requireBase();
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const meta = (html, re) => (html.match(re)?.[1] ? decode(html.match(re)[1]) : null);
const strip = (s) => decode(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const WORKER_KEY = "test-worker-key-0123456789012345678901";
const SECURITY = ["strict-transport-security", "x-content-type-options", "referrer-policy", "permissions-policy", "content-security-policy"];

const get = (path, headers) => rawRequest(path, { headers });

describe("master page, bookable: first HTML (no JS) is complete", async () => {
  const res = await get("/book/oksana-ab12?utm_source=instagram&utm_medium=social&utm_campaign=master_link");
  const h = res.body;
  test("200 HTML, every security header exactly once, indexable", () => {
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/html/);
    for (const k of SECURITY) assert.equal(res.all(k).length, 1, k);
    assert.equal(res.headers["x-robots-tag"], undefined);
    assert.equal(res.headers["cache-control"], "public, max-age=0, s-maxage=30", "browser revalidates, edge keeps the upstream s-maxage");
  });
  test("CSP: API origin, the image origin from the data and Turnstile only; nothing broader", () => {
    const csp = res.headers["content-security-policy"];
    assert.ok(csp.includes(`connect-src 'self' ${MOCK_API} https://challenges.cloudflare.com`), csp);
    assert.ok(csp.includes("img-src 'self' data: https://media.beautica.test;"), csp);
    assert.ok(csp.includes("script-src 'self' https://challenges.cloudflare.com;"), csp);
    assert.ok(csp.includes("frame-src https://challenges.cloudflare.com;"), csp);
    assert.ok(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && !/unsafe-eval/.test(csp));
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "no inline scripts");
  });
  test("title, description, canonical (query stripped), robots, OG, twitter", () => {
    const title = meta(h, /<title>([^<]*)<\/title>/);
    assert.equal(title, "Оксана Коваленко — Майстер манікюру та педикюру · Київ".length <= 60 ? "Оксана Коваленко — Майстер манікюру та педикюру · Київ" : title);
    assert.ok(title.length <= 60, title);
    assert.ok(title.includes("Оксана Коваленко"));
    const d = meta(h, /<meta name="description" content="([^"]*)"/);
    assert.ok(d.length <= 155 && d.includes("Манікюр класичний") && d.includes("від") && d.includes("Запис онлайн"), d);
    assert.equal(meta(h, /<link rel="canonical" href="([^"]*)"/), "https://beautica.app/book/oksana-ab12");
    assert.equal(meta(h, /<meta name="robots" content="([^"]*)"/), "index, follow");
    assert.equal(meta(h, /<meta property="og:title" content="([^"]*)"/), title);
    assert.equal(meta(h, /<meta property="og:image" content="([^"]*)"/), "https://media.beautica.test/avatar.jpg", "og:image is the avatar");
    assert.equal(meta(h, /<meta property="og:url" content="([^"]*)"/), "https://beautica.app/book/oksana-ab12");
    assert.equal(meta(h, /<meta name="twitter:card" content="([^"]*)"/), "summary");
    assert.equal(meta(h, /<html lang="([^"]*)"/), "uk");
  });
  test("exactly one H1: the master's name", () => {
    const h1s = [...h.matchAll(/<h1[\s>][\s\S]*?<\/h1>/g)];
    assert.equal(h1s.length, 1);
    assert.equal(strip(h1s[0][0]), "Оксана Коваленко");
  });
  test("name, title, city, services with «від ₴» prices and durations, bio, reviews are in the HTML", () => {
    const text = strip(h);
    for (const s of ["Майстер манікюру та педикюру", "Київ", "Манікюр класичний", "Манікюр+гель лак", "Педикюр апаратний", "від 450 ₴", "від 650 ₴", "1 год 30 хв", "30 хв", "Роблю манікюр і педикюр", "Марина К.", "Ірина Л.", "Софія Т.", "Дуже акуратна робота", "Нігтьовий сервіс", "Подологія", "128 відгуків", "4.9"]) assert.ok(text.includes(s.replace(/ /g, " ")) || text.includes(s), `missing: ${s}`);
  });
  test("the reviews' authors are shown exactly as the API returned them", () => assert.ok(h.includes("Марина К.") && h.includes("Ірина Л.")));
  test("the app's wording for the booking button and the no-JS fallback are present", () => {
    const text = strip(h);
    assert.ok(text.includes("Записатись до майстра"));
    assert.ok(text.includes("Щоб записатися онлайн, увімкніть JavaScript"));
  });
  test("JSON-LD: HealthAndBeautyBusiness with offers, rating and exactly the rendered reviews + BreadcrumbList", () => {
    const [biz, crumbs] = ldBlocks(h);
    assert.equal(biz["@type"], "HealthAndBeautyBusiness");
    assert.equal(biz.name, "Оксана Коваленко");
    assert.equal(biz.url, "https://beautica.app/book/oksana-ab12");
    assert.equal(biz.address.addressLocality, "Київ");
    assert.equal(biz.makesOffer.length, 4);
    assert.deepEqual(biz.makesOffer[0].priceSpecification, { "@type": "PriceSpecification", minPrice: 450, priceCurrency: "UAH" });
    assert.deepEqual(biz.aggregateRating, { "@type": "AggregateRating", ratingValue: 4.9, reviewCount: 128, bestRating: 5, worstRating: 1 });
    assert.equal(biz.review.length, 3, "one Review per rendered review card");
    assert.equal(biz.review[0].author.name, "Марина К.");
    assert.equal(crumbs["@type"], "BreadcrumbList");
    assert.equal(h.includes("FAQPage"), false);
  });
  test("images carry explicit dimensions; the avatar is eager, portfolio lazy", () => {
    const imgs = [...h.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    assert.ok(imgs.length >= 4);
    for (const i of imgs) assert.ok(/width="\d+"/.test(i) && /height="\d+"/.test(i) && /alt=/.test(i), i);
    assert.ok(!/loading="lazy"/.test(imgs.find((i) => i.includes("avatar.jpg"))));
    assert.ok(/loading="lazy"/.test(imgs.find((i) => i.includes("p2.jpg"))));
  });
  test("no worker key, no secret-looking value and no inline script in the page", () => {
    assert.equal(h.includes(WORKER_KEY), false);
    assert.equal(/<script(?![^>]*(type="application\/(ld\+)?json"|src=))[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(h), false, "no inline executable script");
    assert.equal(/\son[a-z]+="/.test(h), false, "no inline event handlers");
  });
  test("the booking island ships as a module script, not inline", () => assert.match(h, /<script type="module" src="\/_astro\/[^"]+\.js"/));
});

describe("master page without optional data", async () => {
  const res = await get("/book/sparse-0001");
  const h = res.body;
  test("renders, with the app's empty-state copy and no invented data", () => {
    assert.equal(res.status, 200);
    const text = strip(h);
    assert.ok(text.includes("Опис майстра поки не додано"));
    assert.ok(text.includes("Ще немає відгуків"));
    assert.ok(!text.includes("Портфоліо"), "no portfolio block without photos");
    assert.ok(text.includes("—"), "rating shows a dash, never a fabricated 0");
  });
  test("JSON-LD has no rating or review without reviews, and no address without a city", () => {
    const [biz] = ldBlocks(h);
    assert.equal(biz.aggregateRating, undefined);
    assert.equal(biz.review, undefined);
    assert.equal(biz.address, undefined);
  });
  test("title falls back to «name — Запис онлайн»", () => assert.equal(meta(h, /<title>([^<]*)<\/title>/), "Нова Майстриня — Запис онлайн"));
});

describe("states that are not a profile", () => {
  const cases = [
    { slug: "closed-aaaa", status: 200, h1: "Ця сторінка більше не працює", cache: "no-store" },
    { slug: "retired-bbbb", status: 410, h1: "Ця сторінка більше не працює", cache: "no-store" },
    { slug: "nobody-0000", status: 404, h1: "Сторінку не знайдено", cache: "no-store" },
    { slug: "down-cccc", status: 503, h1: "Сторінка тимчасово недоступна", cache: "no-store", retryAfter: "7" },
    { slug: "limited-dddd", status: 429, h1: "Сторінка тимчасово недоступна", cache: "no-store", retryAfter: "12" },
  ];
  for (const c of cases) {
    test(`/book/${c.slug}: ${c.status}, noindex (meta + header), ${c.cache}, no canonical/OG/JSON-LD, one H1`, async () => {
      const res = await get(`/book/${c.slug}`);
      assert.equal(res.status, c.status);
      assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
      assert.equal(res.headers["cache-control"], c.cache);
      assert.equal(res.headers["retry-after"], c.retryAfter);
      for (const k of SECURITY) assert.equal(res.all(k).length, 1, k);
      assert.equal(meta(res.body, /<meta name="robots" content="([^"]*)"/), "noindex, nofollow");
      assert.equal(/rel="canonical"|og:title|application\/ld\+json/.test(res.body), false);
      const h1s = [...res.body.matchAll(/<h1[\s>][\s\S]*?<\/h1>/g)];
      assert.equal(h1s.length, 1);
      assert.equal(strip(h1s[0][0]), c.h1);
      assert.equal(strip(res.body).includes("Записатись до майстра"), false, "no booking button on a page that cannot book");
      assert.equal(/data-book-root/.test(res.body), false);
      assert.ok(meta(res.body, /<title>([^<]*)<\/title>/).length <= 60);
    });
  }
  test("a malformed slug is a 404 and never reaches the backend", async () => {
    await fetch(`${MOCK_API}/__mock/reset`, { method: "POST" });
    for (const bad of ["BAD_slug", "a", "-x-", "%20", "UPPER-1234", "x".repeat(70)]) {
      const res = await get(`/book/${bad}`);
      assert.equal(res.status, 404, bad);
      assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
    }
    const seen = await mockLog((e) => e.path.includes("/info"));
    assert.deepEqual(seen.filter((e) => /BAD_slug|UPPER|xxxxxxxx|%20/.test(e.path)), []);
  });
  test("a slug that looks like a sub-path is not a link page", async () => assert.equal((await get("/book/oksana-ab12/extra")).status, 404));
});

describe("backend contract from the Worker", () => {
  test("every info request carries the Worker key and the visitor IP (CF-Connecting-IP); the key never reaches the browser", async () => {
    const ip = freshIp();
    const res = await get("/book/headers-3333", { "cf-connecting-ip": ip });
    assert.equal(res.status, 200);
    const calls = callsTo(await mockLog(), "GET", "/api/v1/book/headers-3333/info");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["x-beautica-worker-key"], WORKER_KEY);
    // The page forwards the IP in CF-Connecting-IP (what the backend reads). Local workerd drops that header on outbound
    // subrequests, so it can only be asserted where the runtime keeps it; staging must confirm it (see the phase doc).
    if (calls[0].headers["cf-connecting-ip"] !== undefined) assert.equal(calls[0].headers["cf-connecting-ip"], ip);
    assert.equal(calls[0].headers["accept"], "application/json");
    assert.equal(res.body.includes(WORKER_KEY), false);
    assert.equal(JSON.stringify(res.headers).includes(WORKER_KEY), false);
  });
  test("the salon info call carries them too", async () => {
    const ip = freshIp();
    await get("/book/s/salonhdr-4444", { "cf-connecting-ip": ip });
    const calls = callsTo(await mockLog(), "GET", "/api/v1/book/s/salonhdr-4444/info");
    assert.ok(calls.length >= 1);
    assert.ok(calls.every((c) => c.headers["x-beautica-worker-key"] === WORKER_KEY));
  });
  test("edge cache: the second request (also with a UTM query) is served from the cache, the backend is hit once", async () => {
    await get("/book/cache-4444");
    const second = await get("/book/cache-4444?utm_source=telegram&utm_medium=social&utm_campaign=master_link");
    assert.equal(second.headers["x-beautica-cache"], "HIT");
    assert.equal(second.headers["cache-control"], "public, max-age=0, s-maxage=30");
    assert.equal(second.headers["x-beautica-ttl"], undefined);
    for (const k of SECURITY) assert.equal(second.all(k).length, 1, `${k} on a cache hit`);
    assert.equal(callsTo(await mockLog(), "GET", "/api/v1/book/cache-4444/info").length, 1);
    assert.equal(meta(second.body, /<link rel="canonical" href="([^"]*)"/), "https://beautica.app/book/cache-4444");
  });
  test("notices are never cached", async () => {
    await get("/book/closed-aaaa");
    const again = await get("/book/closed-aaaa");
    assert.equal(again.headers["x-beautica-cache"], "MISS");
  });
});

describe("salon page", async () => {
  const res = await get("/book/s/lavanda-1111");
  const h = res.body;
  test("200, indexable, edge-cacheable, CSP with the API + image origins", () => {
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-robots-tag"], undefined);
    assert.equal(res.headers["cache-control"], "public, max-age=0, s-maxage=30");
    assert.ok(res.headers["content-security-policy"].includes("img-src 'self' data: https://media.beautica.test;"));
  });
  test("SEO: title, description, canonical, one H1, JSON-LD (no rating: no reviews are rendered)", () => {
    assert.equal(meta(h, /<link rel="canonical" href="([^"]*)"/), "https://beautica.app/book/s/lavanda-1111");
    assert.equal(meta(h, /<meta name="robots" content="([^"]*)"/), "index, follow");
    assert.ok(meta(h, /<title>([^<]*)<\/title>/).length <= 60);
    assert.ok(meta(h, /<meta name="description" content="([^"]*)"/).length <= 155);
    assert.equal([...h.matchAll(/<h1[\s>]/g)].length, 1);
    assert.equal(strip(h.match(/<h1[\s\S]*?<\/h1>/)[0]), "Салон «Лаванда»");
    const [biz] = ldBlocks(h);
    assert.equal(biz["@type"], "HealthAndBeautyBusiness");
    assert.equal(biz.address.streetAddress, "вул. Хрещатик, 22");
    assert.equal(biz.address.addressLocality, "Київ");
    assert.equal(biz.aggregateRating, undefined);
  });
  test("every bookable master is a link to that master's page (all 8 are in the HTML; none is client-rendered)", () => {
    const links = [...h.matchAll(/<a class="mcard[^"]*" href="(\/book\/[^"]+)"/g)].map((m) => m[1]);
    assert.equal(links.length, 8);
    assert.equal(links[0], "/book/oksana-ab12");
    assert.ok(links.every((l) => /^\/book\/[a-z0-9-]+$/.test(l)));
    assert.ok(strip(h).includes("Майстер Номер8"));
  });
  test("address, rating and review count are shown", () => {
    const text = strip(h);
    assert.ok(text.includes("вул. Хрещатик, 22, Київ") && text.includes("4.8") && text.includes("312 відгуків"));
  });
  test("a salon with no bookable master is the noindex «not accepting bookings» page; unknown = 404", async () => {
    const shut = await get("/book/s/shut-2222");
    assert.equal(shut.status, 200);
    assert.equal(shut.headers["x-robots-tag"], "noindex, nofollow");
    assert.ok(strip(shut.body).includes("Салон зараз не приймає записи"));
    assert.equal((await get("/book/s/nosalon-3333")).status, 404);
    assert.equal((await get("/book/s/BAD_slug")).status, 404);
  });
});

describe("site wiring", () => {
  test("link pages are in no sitemap", async () => {
    for (const p of ["/sitemap-index.xml", "/sitemap-0.xml"]) {
      const res = await get(p);
      if (res.status === 200) assert.equal(res.body.includes("/book"), false, p);
    }
  });
  test("/book/cancel/{token} is still the static no-store shell (the Worker does not take it over)", async () => {
    const res = await get("/book/cancel/123e4567-e89b-42d3-a456-426614174000");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["x-beautica-cache"], undefined);
  });
  test("the app's icons are served as assets", async () => {
    for (const p of ["/icons/star.svg", "/icons/category_nail_service.svg"]) assert.equal((await get(p)).status, 200, p);
  });
});

describe("rendering at 360 / 768 / 1280", () => {
  let browser;
  before(async () => (browser = await launch()));
  after(async () => browser?.close());
  const ROUTES = [
    { path: "/book/oksana-ab12", name: "master", boxes: [".avatar-well", ".stat", ".rolechip", ".tab", ".bio", ".ptile"], h1: "Оксана Коваленко" },
    { path: "/book/sparse-0001", name: "master-sparse", boxes: [".avatar-well", ".stat"], h1: "Нова Майстриня" },
    { path: "/book/s/lavanda-1111", name: "salon", boxes: [".cover", ".hero-wrap", ".slogo", ".mcard", ".shelf .cta"], h1: "Салон «Лаванда»" },
    { path: "/book/closed-aaaa", name: "unbookable", boxes: [".notice"], h1: "Ця сторінка більше не працює" },
    { path: "/book/nobody-0000", name: "notfound", boxes: [".notice"], h1: "Сторінку не знайдено", status: 404 },
  ];
  for (const width of [360, 768, 1280]) {
    for (const r of ROUTES) {
      test(`${r.name} @${width}: visible H1, every drawn element has a box, no overflow, targets >= 48 px, no errors`, async () => {
        const env = await bookPage(browser, null, { width, path: r.path });
        try {
          const { page, problems, external } = env;
          assert.equal(env.res.status(), r.status ?? 200);
          await page.waitForLoadState("networkidle");
          const h1 = page.getByRole("heading", { level: 1 });
          assert.equal(await h1.count(), 1);
          assert.equal((await h1.innerText()).trim(), r.h1);
          assert.ok(await visibleBox(h1), "H1 has no box");
          for (const sel of r.boxes) {
            const loc = page.locator(sel).first();
            assert.ok(await loc.count(), `${sel} missing`);
            assert.ok(await visibleBox(loc), `${sel} has no box`);
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          assert.ok(overflow <= 0, `horizontal scroll ${overflow}px`);
          const small = await page.evaluate(() =>
            [...document.querySelectorAll("a[href], button, input, textarea")]
              .filter((e) => !e.closest("[hidden]") && getComputedStyle(e).visibility !== "hidden")
              .map((e) => ({ t: e.tagName + "." + e.className, b: e.getBoundingClientRect() }))
              .filter(({ b }) => b.width > 0 && b.height > 0 && (b.width < 48 || b.height < 48))
              .map(({ t, b }) => `${t} ${Math.round(b.width)}x${Math.round(b.height)}`),
          );
          assert.deepEqual(small, [], "touch targets under 48 px");
          const column = await page.evaluate(() => Math.round(document.querySelector(".phone").getBoundingClientRect().width));
          assert.ok(column <= 420, `column is ${column}px (max 420)`);
          const expected404 = r.status === 404 ? ["console: Failed to load resource: the server responded with a status of 404 (Not Found)"] : [];
          assert.deepEqual(problems, expected404);
          assert.deepEqual(external.filter((u) => !u.startsWith("https://challenges.cloudflare.com")), [], "no unexpected origin");
          await shot(page, `${r.name}-${width}`);
        } finally {
          await env.context.close();
        }
      });
    }
  }
  test("wide screens centre one 420 px column", async () => {
    const env = await bookPage(browser, null, { width: 1280, path: "/book/oksana-ab12" });
    try {
      const b = await env.page.locator(".phone").boundingBox();
      assert.equal(Math.round(b.width), 420);
      assert.ok(Math.abs(b.x - (1280 - 420) / 2) <= 1, `column x=${b.x}`);
    } finally {
      await env.context.close();
    }
  });
  test("tabs: without JS every panel is in the page; with JS they become tabs and swap", async () => {
    const noJs = await bookPage(browser, null, { path: "/book/oksana-ab12", js: false });
    try {
      for (const sel of ["[data-panel='0']", "[data-panel='1']", "[data-panel='2']"]) assert.ok(await visibleBox(noJs.page.locator(sel)), `${sel} hidden without JS`);
      assert.equal(await noJs.page.locator("[data-tabs]").isVisible(), true, "the tab bar is server-rendered (anchor links): no shift when the script runs");
      assert.deepEqual(await noJs.page.locator("[data-tabs] a").evaluateAll((a) => a.map((x) => x.getAttribute("href"))), ["#panel-0", "#panel-1", "#panel-2"]);
      assert.equal(await noJs.page.locator("[role=tab]").count(), 0, "no ARIA tab roles without the script");
      assert.equal(await noJs.page.locator("#book-cta").isVisible(), false, "the booking button needs JS");
      assert.equal(await noJs.page.locator("[data-nojs]").isVisible(), true, "the JS-required note is shown");
    } finally {
      await noJs.context.close();
    }
    const js = await bookPage(browser, null, { path: "/book/oksana-ab12" });
    try {
      const { page } = js;
      await page.waitForSelector("[data-tabs][role=tablist]");
      assert.equal(await page.locator("[data-panel='0']").isVisible(), true);
      assert.equal(await page.locator("[data-panel='1']").isVisible(), false);
      await page.getByRole("tab", { name: "Відгуки" }).click();
      assert.equal(await page.locator("[data-panel='2']").isVisible(), true);
      assert.equal(await page.locator("[data-panel='0']").isVisible(), false);
      assert.equal(await page.getByRole("tab", { name: "Відгуки" }).getAttribute("aria-selected"), "true");
    } finally {
      await js.context.close();
    }
  });
  test("salon: masters beyond the first six collapse behind «Показати всіх майстрів» only with JS", async () => {
    const env = await bookPage(browser, null, { path: "/book/s/lavanda-1111" });
    try {
      const { page } = env;
      await page.waitForSelector("#showall:not([hidden])");
      assert.equal(await page.locator("#mrest").isVisible(), false);
      await page.click("#showall");
      assert.equal(await page.locator("#mrest").isVisible(), true);
      assert.equal(await page.locator("#showall").isVisible(), false);
    } finally {
      await env.context.close();
    }
  });
  test("a master card of the salon opens that master's page (and the master page links back to the salon)", async () => {
    const env = await bookPage(browser, null, { path: "/book/s/lavanda-1111" });
    try {
      await env.page.locator(".mcard").first().click();
      await env.page.waitForURL(`${BASE}/book/oksana-ab12`);
      assert.equal(await env.page.getByRole("heading", { level: 1 }).innerText(), "Оксана Коваленко");
    } finally {
      await env.context.close();
    }
    const sm = await bookPage(browser, null, { path: "/book/salonmaster-5555" });
    try {
      assert.equal(await sm.page.locator("header.topbar a.nib").getAttribute("href"), "/book/s/lavanda-1111");
    } finally {
      await sm.context.close();
    }
  });
});
