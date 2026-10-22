// Phase 008: the SSR link pages /book/{slug} and /book/s/{slug} against the mock backend (tests/helpers/mock-api.mjs).
// States, first-HTML content (no JS), SEO + JSON-LD, headers, edge cache, forwarded headers, no leaks, rendering at 360/768/1280.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { rawRequest, requireBase, freshIp, BASE, MOCK_API } from "./helpers/env.mjs";
import { launch } from "./helpers/browser.mjs";
import { bookPage, mockLog, callsTo, shot } from "./helpers/book.mjs";
import { EVIL } from "./helpers/mock-api.mjs";
import { visibleBox } from "./helpers/browser.mjs";
const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());

requireBase();
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const meta = (html, re) => (html.match(re)?.[1] ? decode(html.match(re)[1]) : null);
const strip = (s) => decode(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const WORKER_KEY = "test-worker-key-0123456789012345678901";
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());
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
  test("unbookable / retired: one full-width card, no extra button (as the design's 410 state)", async () => {
    const env = await bookPage(browser, "closed-aaaa");
    try {
      const card = await env.page.locator(".notice").boundingBox();
      assert.ok(card.width >= 360 - 2 * 24 - 1, `card is ${card.width}px wide: it spans the column`);
      assert.equal(await env.page.locator(".notice a, .notice button").count(), 0);
    } finally {
      await env.context.close();
    }
    const nf = await get("/book/nobody-0000");
    assert.ok(nf.body.includes("На головну"), "a 404 keeps the way back");
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
  test("og:type is website and the description does not repeat «Салон»", () => {
    assert.equal(meta(h, /<meta property="og:type" content="([^"]*)"/), "website");
    assert.equal(/Салон Салон/.test(meta(h, /<meta name="description" content="([^"]*)"/)), false);
    assert.ok(meta(h, /<meta name="description" content="([^"]*)"/).startsWith("Салон «Лаванда»:"));
  });
  test("SEO: title, description, canonical, one H1, JSON-LD", () => {
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
    assert.equal(biz.aggregateRating.ratingValue, 4.8);
  });
  test("every bookable master is a link to that master's page (all 8 are in the HTML; none is client-rendered)", () => {
    const links = [...h.matchAll(/<a class="mcard[^"]*" href="(\/book\/[^"]+)"/g)].map((m) => m[1]);
    assert.equal(links.length, 8);
    assert.equal(links[0], "/book/oksana-ab12");
    assert.ok(links.every((l) => /^\/book\/[a-z0-9-]+$/.test(l)));
    assert.ok(strip(h).includes("Майстер8"));
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

describe("legal pages say what the booking does (guest booking is live)", () => {
  test("privacy §3: no «not possible yet», phone AND name shared with the master, Turnstile + consent + policy date", async () => {
    const t = strip((await get("/privacy")).body);
    assert.equal(t.includes("поки що не можна"), false);
    assert.ok(t.includes("за посиланням, яким поділився майстер або салон"));
    assert.ok(/бачить ваше ім.я, прізвище, номер телефону/.test(t), "the master sees the phone (user decision 2026-10-22)");
    assert.equal(t.includes("Номер телефону їм не показується"), false);
    assert.ok(t.includes("Cloudflare Turnstile") && t.includes("позначку згоди"));
    assert.ok(t.includes("перевірка Turnstile під час гостьового запису"), "Turnstile is listed under the Cloudflare processor");
    assert.ok((await get("/privacy")).body.includes("2026-10-22") || t.includes("22 жовтня 2026") || t.includes("2026"), "page shows its date");
  });
  test("terms and support: guest booking is described as available; no guest-booking «add when live» markers remain", async () => {
    const terms = strip((await get("/terms")).body);
    const support = strip((await get("/support")).body);
    assert.equal(terms.includes("поки недоступний"), false);
    assert.ok(terms.includes("Записатися без акаунта (гість) можна на сайті"));
    assert.equal(support.includes("поки недоступний"), false);
    assert.ok(support.includes("Так, на сайті за посиланням майстра чи салону"));
  });
});

describe("guest cancel link uses the same API origin config", () => {
  test("/book/cancel/{token}: data-api and CSP connect-src are the Worker's API_ORIGIN, headers stay hardened, trailing slash 307", async () => {
    const res = await get("/book/cancel/123e4567-e89b-42d3-a456-426614174000");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(`data-api="${MOCK_API}"`), "the shell carries the runtime API origin");
    assert.ok(res.headers["content-security-policy"].includes(`connect-src 'self' ${MOCK_API};`));
    assert.equal(res.headers["content-security-policy"].includes("api.beautica.app"), false);
    assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
    assert.deepEqual(res.all("cache-control"), ["no-store"]);
    assert.deepEqual(res.all("x-robots-tag"), ["noindex, nofollow"]);
    const slash = await get("/book/cancel/123e4567-e89b-42d3-a456-426614174000/?x=1");
    assert.equal(slash.status, 307);
    assert.equal(slash.headers.location, "/book/cancel/123e4567-e89b-42d3-a456-426614174000?x=1");
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
  const ROUTES = [
    { path: "/book/oksana-ab12", name: "master", boxes: [".avatar-well", ".stat", ".rolechip", ".shelf .cta", ".tab", ".bio", ".ptile"], h1: "Оксана Коваленко" },
    { path: "/book/sparse-0001", name: "master-sparse", boxes: [".avatar-well", ".stat", ".shelf .cta"], h1: "Нова Майстриня" },
    { path: "/book/s/lavanda-1111", name: "salon", boxes: [".cover", ".hero-wrap", ".slogo", "[data-tabs]", ".bio-text", ".shelf .cta"], h1: "Салон «Лаванда»" },
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
      assert.equal(await page.locator("[data-nojs]").isVisible(), false);
      assert.equal(await page.locator("#book-cta").isVisible(), true);
    } finally {
      await js.context.close();
    }
  });
  test("salon: masters beyond the first six collapse behind «Показати всіх майстрів» only with JS", async () => {
    const env = await bookPage(browser, null, { path: "/book/s/lavanda-1111" });
    try {
      const { page } = env;
      await page.getByRole("tab", { name: "Майстри" }).click();
      await page.waitForSelector("#showall:not([hidden])");
      assert.equal(await page.locator("#mrest").isVisible(), false);
      await page.click("#showall");
      assert.equal(await page.locator("#mrest").isVisible(), true);
      assert.equal(await page.locator("#showall").isVisible(), false);
    } finally {
      await env.context.close();
    }
  });
  test("design fidelity: portfolio is a horizontal rail, panels start under the tabs with no extra label, CTA has the app's light-to-dark face, no-photo avatar is the person icon", async () => {
    const env = await bookPage(browser, "rail-8888");
    try {
      const { page } = env;
      const rail = await page.locator(".rail").evaluate((r) => ({ sw: r.scrollWidth, cw: r.clientWidth, ox: getComputedStyle(r).overflowX, tops: [...r.children].map((c) => Math.round(c.getBoundingClientRect().top)) }));
      assert.ok(rail.sw > rail.cw && rail.ox === "auto", `rail scrolls sideways (${rail.sw} > ${rail.cw})`);
      assert.equal(new Set(rail.tops).size, 1, "tiles stay on one row");
      await page.waitForSelector("[data-tabs][role=tablist]");
      await page.getByRole("tab", { name: "Послуги" }).click();
      const first = await page.locator("[data-panel='1']").evaluate((p) => {
        const visible = [...p.children].find((c) => c.getBoundingClientRect().height > 1);
        return visible.className;
      });
      assert.match(first, /cat-group/, "the services panel opens with the category accordions, not a heading");
      const gap = await page.evaluate(() => document.querySelector("[data-panel='1'] .cat").getBoundingClientRect().top - document.querySelector(".tabs").getBoundingClientRect().bottom);
      assert.ok(gap >= 20 && gap <= 30, `underline to first category card is ${gap}px (design 25)`);
      const bg = await page.locator("#book-cta").evaluate((b) => getComputedStyle(b).backgroundImage);
      assert.equal((bg.match(/linear-gradient/g) ?? []).length, 2, "overlay + accent gradient");
    } finally {
      await env.context.close();
    }
    const sp = await bookPage(browser, "sparse-0001");
    try {
      assert.ok(await visibleBox(sp.page.locator(".avatar-well svg")), "person icon placeholder");
      const ph = await sp.page.locator(".avatar-well svg").evaluate((s) => ({ w: s.getBoundingClientRect().width, fill: getComputedStyle(s).fill, color: getComputedStyle(s.closest(".avatar-well")).color, op: getComputedStyle(s).opacity }));
      assert.ok(ph.w >= 40, `icon is ${ph.w}px wide`);
      assert.ok(ph.fill !== "none" && ph.op === "1" && ph.color !== "rgba(0, 0, 0, 0)", JSON.stringify(ph));
      assert.equal(await sp.page.locator(".avatar-well img").count(), 0);
    } finally {
      await sp.context.close();
    }
  });
  test("a master card of the salon opens that master's page (and the master page links back to the salon)", async () => {
    const env = await bookPage(browser, null, { path: "/book/s/lavanda-1111" });
    try {
      await env.page.getByRole("tab", { name: "Майстри" }).click();
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

describe("parity with the app (backend 383-385)", () => {
  test("master: services are category accordions (API order) with count badges; the header shows street + note", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      const hero = (await text(page.locator(".hero-row"))).replace(/\s+/g, " ");
      assert.ok(hero.includes("Київ, вул. Хрещатик, 22") && hero.includes("2 поверх, офіс 5"), hero);
      await page.getByRole("tab", { name: "Послуги" }).click();
      const groups = await page.locator("[data-panel='1'] [data-cat-group]").evaluateAll((gs) => gs.map((g) => ({ name: g.querySelector(".lbl").textContent.trim(), badge: g.querySelector(".badge:not(.sel)").textContent.trim(), tiles: g.querySelectorAll(".stile").length, open: g.open })));
      assert.deepEqual(groups, [
        { name: "Нігтьовий сервіс", badge: "2", tiles: 2, open: false },
        { name: "Подологія", badge: "1", tiles: 1, open: false },
        { name: "Оформлення брів", badge: "1", tiles: 1, open: false },
      ]);
      await page.locator("[data-panel='1'] summary").first().click();
      assert.equal(await page.locator("[data-panel='1'] [data-cat-group]").first().evaluate((g) => g.open), true, "collapsed by default (as the design), opens on tap");
      assert.ok(await page.locator("[data-panel='1'] [data-cat-group] .ai").first().evaluate((e) => getComputedStyle(e).maskImage.includes("category_nail_service.svg")), "icon follows the category key");
    } finally {
      await env.context.close();
    }
  });

  test("master: JSON-LD carries the street; a master without an address has none", async () => {
    const [biz] = ldBlocks((await get("/book/oksana-ab12")).body);
    assert.equal(biz.address.streetAddress, "вул. Хрещатик, 22");
    assert.equal(ldBlocks((await get("/book/salonmaster-5555")).body)[0].address.streetAddress, undefined, "salon masters have no street of their own");
  });

  test("reviews: distribution bars from the API (5 -> 1, zero-filled), widths = share of all reviews", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      await page.getByRole("tab", { name: "Відгуки" }).click();
      const rows = await page.locator("[data-panel='2'] .drow").evaluateAll((rs) => rs.map((r) => [r.children[0].textContent.trim(), r.querySelector(".cnt").textContent.trim(), r.querySelector(".fillbar").style.width]));
      assert.deepEqual(rows.map((r) => r.slice(0, 2)), [["5", "110"], ["4", "14"], ["3", "3"], ["2", "1"], ["1", "0"]]);
      assert.equal(rows[0][2], "85.9%");
      assert.equal(rows[4][2], "0%");
      assert.ok(await visibleBox(page.locator("[data-panel='2'] .rsum .divider")));
    } finally {
      await env.context.close();
    }
  });

  test("reviews without JS: the sort menu is ?sort= links; the server renders page 0 of that sort, cached separately from the default", async () => {
    const def = await get("/book/oksana-ab12");
    assert.ok(def.body.includes('href="?sort=LOWEST#panel-2"'));
    const low = await get("/book/oksana-ab12?sort=LOWEST");
    const text1 = strip(low.body);
    assert.ok(text1.indexOf("Клієнт5 К.") > -1 && text1.indexOf("Клієнт5 К.") < text1.indexOf("Клієнт3 К."), "lowest rating first");
    assert.equal(text1.includes("Марина К."), false, "the default view's reviews are not mixed in");
    const again = await get("/book/oksana-ab12?sort=LOWEST&utm_source=x");
    assert.equal(again.headers["x-beautica-cache"], "HIT");
    assert.equal(strip(again.body), text1);
    assert.equal(strip((await get("/book/oksana-ab12")).body).includes("Марина К."), true, "the default entry is untouched");
    await fetch(`${MOCK_API}/__mock/reset`, { method: "POST" });
    await get("/book/sparse-0001?sort=BOGUS");
    assert.deepEqual(await mockLog((e) => e.path.includes("BOGUS")), [], "an unknown sort never reaches the backend");
  });

  test("reviews with JS: re-sort replaces the list from /reviews, «Показати ще» appends the next page, errors are shown", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      await page.getByRole("tab", { name: "Відгуки" }).click();
      assert.equal(await page.locator("[data-review-list] article").count(), 3);
      await page.locator("[data-sortmenu] summary").click();
      await page.locator("[data-sort-option=HIGHEST]").click();
      await page.waitForFunction(() => document.querySelectorAll("[data-review-list] article").length === 5);
      assert.equal(await text(page.locator("[data-sort-label]")), "Найвищий рейтинг");
      const first = await page.locator("[data-review-list] article").first().evaluate((a) => ({ name: a.querySelector(".t-sub12").textContent, on: a.querySelectorAll(".stars .on").length, svc: a.querySelector(".svc .t-fb").textContent }));
      assert.equal(first.on, 5);
      assert.ok(first.name.startsWith("Клієнт"));
      const req = (await mockLog((e) => e.path.includes("/reviews?sort=HIGHEST"))).at(-1);
      assert.equal(req.path, "/api/v1/book/oksana-ab12/reviews?sort=HIGHEST&page=0&size=5");
      await page.click("[data-more]");
      await page.waitForFunction(() => document.querySelectorAll("[data-review-list] article").length === 10);
      await page.click("[data-more]");
      await page.waitForFunction(() => document.querySelectorAll("[data-review-list] article").length === 12);
      assert.equal(await page.locator("[data-more]").isVisible(), false, "no more pages");
      const ratings = await page.locator("[data-review-list] article").evaluateAll((as) => as.map((a) => a.querySelectorAll(".stars .on").length));
      assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), "highest first across pages");
      await page.context().route(`${MOCK_API}/api/v1/book/oksana-ab12/reviews*`, (r) => r.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, body: "" }));
      await page.locator("[data-sortmenu] summary").click();
      await page.locator("[data-sort-option=OLDEST]").click();
      await page.waitForSelector("[data-rev-status]:not([hidden])");
      assert.ok((await text(page.locator("[data-rev-status]"))).includes("Не вдалося завантажити відгуки"));
    } finally {
      await env.context.close();
    }
  });

  test("backend contract of /reviews: a bad sort is 400, size is clamped to 20 (the mock mirrors the backend)", async () => {
    assert.equal((await fetch(`${MOCK_API}/api/v1/book/oksana-ab12/reviews?sort=NOPE`)).status, 400);
    const j = await (await fetch(`${MOCK_API}/api/v1/book/s/lavanda-1111/reviews?sort=NEWEST&size=99`)).json();
    assert.equal(j.size, 20);
    assert.equal(j.totalElements, 12);
  });

  test("salon: four tabs in the app's order, anchor links without JS, ARIA tabs with JS", async () => {
    const html = (await get("/book/s/lavanda-1111")).body;
    assert.deepEqual([...html.matchAll(/<a class="tab"[^>]*href="(#panel-\d)"/g)].map((m) => m[1]), ["#panel-0", "#panel-1", "#panel-2", "#panel-3"]);
    const t = strip(html);
    for (const s of ["Про салон", "Майстри", "Послуги", "Відгуки", "Світлий салон у центрі Києва", "Вхід з двору, 2 поверх", "Нігтьовий сервіс", "600 - 900 ₴", "Клієнт0 К.", "270"]) assert.ok(t.includes(s), s);
    assert.equal(/role="tab"/.test(html), false);
    const env = await bookPage(browser, null, { path: "/book/s/lavanda-1111" });
    try {
      const { page } = env;
      await page.waitForSelector("[data-tabs][role=tablist]");
      assert.deepEqual(await page.getByRole("tab").allInnerTexts(), ["Про салон", "Майстри", "Послуги", "Відгуки"]);
      assert.equal(await page.locator("[data-panel='1']").isVisible(), false);
      await page.locator(".shelf a.cta").click();
      assert.equal(await page.locator("[data-panel='1']").isVisible(), true, "«Записатись на послугу» opens the masters tab");
      await page.getByRole("tab", { name: "Послуги" }).click();
      const open = await page.locator("[data-panel='2'] [data-cat-group]").evaluateAll((gs) => gs.map((g) => [g.querySelector(".lbl").textContent.trim(), g.querySelector(".badge:not(.sel)").textContent.trim(), g.open]));
      assert.deepEqual(open, [["Нігтьовий сервіс", "2", true], ["Оформлення брів", "1", false]], "first group open, the rest collapsed, backend counts");
      await page.getByRole("tab", { name: "Про салон" }).click();
      assert.ok(await visibleBox(page.locator("[data-panel='0'] .rail")), "portfolio rail");
      await page.getByRole("tab", { name: "Відгуки" }).click();
      assert.equal(await page.locator("[data-panel='3'] .drow").count(), 5);
      await page.locator("[data-sortmenu] summary").click();
      await page.locator("[data-sort-option=LOWEST]").click();
      await page.waitForFunction(() => document.querySelector("[data-review-list] article .stars .on")?.parentElement.querySelectorAll(".on").length === 1);
      assert.ok((await mockLog((e) => e.path.includes("/s/lavanda-1111/reviews?sort=LOWEST"))).length >= 1);
    } finally {
      await env.context.close();
    }
  });

  test("salon JSON-LD: rating and the rendered reviews are included now that the page renders them; offers come from the service groups", async () => {
    const [biz] = ldBlocks((await get("/book/s/lavanda-1111")).body);
    assert.equal(biz.aggregateRating.reviewCount, 312);
    assert.equal(biz.review.length, 5);
    assert.deepEqual(biz.makesOffer.map((o) => o.itemOffered.name), ["Манікюр класичний", "Манікюр+гель лак", "Корекція брів"]);
  });
});

describe("audit cycle 3", () => {
  test("portfolio rails are keyboard-reachable regions (master and salon)", async () => {
    for (const [path, tab, label] of [["/book/oksana-ab12", null, "Портфоліо"], ["/book/s/lavanda-1111", null, "Портфоліо"]]) {
      const env = await bookPage(browser, null, { path });
      try {
        const rail = env.page.locator(".rail");
        assert.equal(await rail.getAttribute("tabindex"), "0", path);
        assert.equal(await rail.evaluate((e) => e.tagName), "SECTION", "a labelled <section> is the region landmark");
        assert.equal(await rail.getAttribute("aria-label"), label);
      } finally {
        await env.context.close();
      }
    }
  });

  test("JSON-LD has no review (and no rating) on a sorted view of a master without reviews", async () => {
    const [biz] = ldBlocks((await get("/book/sparse-0001?sort=LOWEST")).body);
    assert.equal(biz.review, undefined);
    assert.equal(biz.aggregateRating, undefined);
  });

  test("rating bars are labelled «5 зірок: 110» with Ukrainian plurals", async () => {
    const h = (await get("/book/oksana-ab12")).body;
    for (const l of ["5 зірок: 110", "4 зірки: 14", "3 зірки: 3", "2 зірки: 1", "1 зірка: 0"]) assert.ok(h.includes(`aria-label="${l}"`), l);
  });

  test("a sorted view is noindex, follow (meta + header) with the canonical kept; the default view stays index", async () => {
    for (const path of ["/book/oksana-ab12", "/book/s/lavanda-1111"]) {
      const sorted = await get(`${path}?sort=OLDEST`);
      assert.equal(sorted.headers["x-robots-tag"], "noindex, follow", path);
      assert.equal(meta(sorted.body, /<meta name="robots" content="([^"]*)"/), "noindex, follow");
      assert.equal(meta(sorted.body, /<link rel="canonical" href="([^"]*)"/), `https://beautica.app${path}`);
      const def = await get(path);
      assert.equal(def.headers["x-robots-tag"], undefined);
      assert.equal(meta(def.body, /<meta name="robots" content="([^"]*)"/), "index, follow");
      const again = await get(`${path}?sort=OLDEST`);
      assert.equal(again.headers["x-robots-tag"], "noindex, follow", "also on a cache hit");
    }
  });

  test("salon: logo initial skips «Салон» (Л), master cards show the first name and the ★ rating (none while unreviewed)", async () => {
    const h = (await get("/book/s/lavanda-1111")).body;
    assert.match(h, /class="slogo"[^>]*>Л</);
    const names = [...h.matchAll(/<a class="mcard[^>]*>[\s\S]*?<span class="t-sub11 ellipsis">([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.equal(names[0], "Майстер1");
    assert.equal(strip(h).includes("Майстер1 Тест"), false, "first name only, as in the design");
    const rates = [...h.matchAll(/<a class="mcard[^>]*>[\s\S]*?<\/a>/g)].map((m) => (m[0].match(/class="t-strong11">([^<]*)</) ?? [])[1] ?? null);
    assert.deepEqual(rates, ["4.9", "4.8", null, "4.7", "5.0", "4.6", "4.9", "4.5"], "★ rating per master as the app's card; no line while unreviewed");
  });

  test("the location note is aligned under the address text (same left edge as the street line)", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const x = await env.page.evaluate(() => {
        const left = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().left; };
        return [left(document.querySelector(".meta-line .t-fb")), left(document.querySelector(".addr-note"))];
      });
      assert.ok(Math.abs(x[0] - x[1]) <= 1.5, `street text at ${x[0]}, note at ${x[1]}`);
    } finally {
      await env.context.close();
    }
  });

  test("tabs follow the WAI-ARIA pattern: roving tabindex, arrows / Home / End move and select", async () => {
    for (const [path, names] of [["/book/oksana-ab12", ["Про майстра", "Послуги", "Відгуки"]], ["/book/s/lavanda-1111", ["Про салон", "Майстри", "Послуги", "Відгуки"]]]) {
      const env = await bookPage(browser, null, { path });
      try {
        const { page } = env;
        await page.waitForSelector("[role=tablist]");
        const tabs = page.getByRole("tab");
        assert.deepEqual(await tabs.evaluateAll((ts) => ts.map((t) => t.tabIndex)), names.map((_, i) => (i === 0 ? 0 : -1)));
        await tabs.first().focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), names[1]);
        assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
        assert.equal(await tabs.nth(1).getAttribute("tabindex"), "0");
        assert.equal(await tabs.first().getAttribute("tabindex"), "-1");
        await page.keyboard.press("End");
        assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), names.at(-1));
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), names[0], "wraps around");
        await page.keyboard.press("ArrowLeft");
        assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), names.at(-1));
        await page.keyboard.press("Home");
        assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), names[0]);
      } finally {
        await env.context.close();
      }
    }
  });

  test("sort popover: Escape and an outside click close it; near the bottom it opens upwards, inside the visible area", async () => {
    const env = await bookPage(browser, "oksana-ab12", { height: 520 });
    try {
      const { page } = env;
      await page.getByRole("tab", { name: "Відгуки" }).click();
      const menu = page.locator("[data-sortmenu]");
      await menu.locator("summary").click();
      assert.equal(await menu.evaluate((d) => d.open), true);
      await page.keyboard.press("Escape");
      assert.equal(await menu.evaluate((d) => d.open), false, "Escape closes");
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY", "focus returns to the button");
      await menu.locator("summary").click();
      await page.locator("body").click({ position: { x: 2, y: 2 } });
      assert.equal(await menu.evaluate((d) => d.open), false, "an outside click closes");
      // Scroll so the sort row is close to the sticky shelf, then open: the menu must not end up under the shelf.
      await page.evaluate(() => document.querySelector(".sortrow").scrollIntoView({ block: "end" }));
      await menu.locator("summary").click();
      const geo = await page.evaluate(() => {
        const m = document.querySelector("[data-sortmenu] .menu").getBoundingClientRect();
        const shelf = document.querySelector(".shelf").getBoundingClientRect();
        return { top: m.top, bottom: m.bottom, shelfTop: shelf.top, up: document.querySelector("[data-sortmenu] .menu").classList.contains("up") };
      });
      assert.ok(geo.top >= 0 && (geo.bottom <= geo.shelfTop + 1), `menu ${geo.top}..${geo.bottom}, shelf at ${geo.shelfTop}`);
      assert.equal(geo.up, true);
    } finally {
      await env.context.close();
    }
  });
});

describe("html validity and robots consistency", () => {
  test("rails are <section> (focusable, labelled); notice pages stay noindex, nofollow even with ?sort=", async () => {
    for (const path of ["/book/oksana-ab12", "/book/s/lavanda-1111"]) {
      const h = (await get(path)).body;
      assert.match(h, /<section class="rail" tabindex="0" aria-label="Портфоліо"/);
      assert.equal(/<div class="rail"/.test(h), false);
    }
    for (const path of ["/book/nobody-0000?sort=OLDEST", "/book/closed-aaaa?sort=LOWEST", "/book/s/nosalon-3333?sort=OLDEST"]) {
      const r = await get(path);
      assert.equal(r.headers["x-robots-tag"], "noindex, nofollow", path);
      assert.equal(meta(r.body, /<meta name="robots" content="([^"]*)"/), "noindex, nofollow", path);
    }
  });
});

describe("user text never becomes markup (stored HTML injection)", () => {
  // Quoted attribute values (og:title ...) may hold a literal "<": inert there (quotes are escaped), so they are not counted.
  const scripts = (h) => { const t = h.replace(/="[^"]*"/g, '=""'); return { open: (t.match(/<script[\s>]/gi) ?? []).length, close: (t.match(/<\/script/gi) ?? []).length }; };
  test("master page: hostile bio, title, review, author stay text; the JSON-LD parses back to the exact strings", async () => {
    const h = (await get("/book/evil-0666")).body;
    const s = scripts(h);
    assert.equal(s.open, s.close, `unbalanced script tags: ${JSON.stringify(s)}`);
    assert.equal(/<img src=x|<svg onload|<meta http-equiv|onerror=alert|<b>Автор/i.test(h.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/="[^"]*"/g, '=""').replace(/&lt;[^]*?&gt;/g, "")), false, "no injected element survives outside escaped text and inert attribute values");
    const [biz] = ldBlocks(h);
    assert.equal(biz.description, EVIL.bio);
    assert.equal(biz.review[0].reviewBody, EVIL.comment);
    assert.equal(biz.review[0].author.name, EVIL.author);
    const raw = h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    assert.equal(/[<>&\u2028\u2029]/.test(raw), false, "the serialized JSON has none of the characters that end an HTML context");
    assert.ok(raw.includes("\\u003c/script\\u003e"));
  });
  test("master page in a browser: no injected element, no refresh, the text is shown literally", async () => {
    const env = await bookPage(browser, "evil-0666");
    try {
      const { page } = env;
      assert.equal(await page.locator("img[src='x'], svg[onload], meta[http-equiv]").count(), 0);
      assert.ok(page.url().endsWith("/book/evil-0666"), "no meta refresh happened");
      assert.ok((await text(page.locator("[data-panel='0']"))).includes(EVIL.bio), "the bio is displayed as text");
    } finally {
      await env.context.close();
    }
  });
  test("salon page: a hostile description is inert too", async () => {
    const h = (await get("/book/s/evilsalon-0666")).body;
    const s = scripts(h);
    assert.equal(s.open, s.close);
    assert.equal(/<script>alert\(3\)/.test(h), false);
    assert.equal(ldBlocks(h)[0].description, EVIL.salon);
  });
});
