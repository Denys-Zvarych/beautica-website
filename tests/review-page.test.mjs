// Phase 019: the guest review page /r/{token}. SSR token route (headers, no analytics, no token echo) + the island in a real browser,
// against the mock backend (tests/helpers/mock-api.mjs, contract of backend 401). Every test owns its token (the mock marks a submitted token spent).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { BASE, MOCK_API, rawRequest, requireBase } from "./helpers/env.mjs";
import { bookPage, callsTo, mockLog, shot } from "./helpers/book.mjs";
import { formatRating } from "../src/lib/booking/format.ts";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const tok = (kind, n) => `${kind}-test-${String(n).padStart(8, "0")}`;
const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());
const quiet = (env) => assert.deepEqual(env.problems.filter((p) => !/status of (400|404|409|429)|net::ERR_FAILED/.test(p)), [], "no console / page errors");
const reviewPage = (token, opts = {}) => bookPage(browser, token, { path: `/r/${token}`, clock: false, ...opts });
const visibleScreen = (page) => page.locator("[data-review-root] [data-screen]:not([hidden])").getAttribute("data-screen");
const rate = (page, n, v) => page.locator(`[data-svc]`).nth(n).locator(`.starbtn[data-v="${v}"]`).click();
const RATING = (avg, n) => `${formatRating(avg)} (${n})`; // the shared helper's format, mock invite avgRating 4.9 / reviewCount 128
const submitAll = async (page, stars) => {
  for (let i = 0; i < stars; i++) await rate(page, i, 5);
  await widgetReady(page, "ts-form");
  await page.click("#rv-submit");
  await page.waitForSelector("[data-screen=success]:not([hidden])", SLOW);
};
const SLOW = { timeout: 30000 }; // a loaded runner (parallel CI shards) needs well over Playwright's 15 s default
const widgetReady = (page, id) => page.waitForSelector(`#${id} iframe`, { state: "attached", ...SLOW }); // the Turnstile widget must be mounted before a click that needs its token
const POST_API = (token, tail) => `/api/v1/public/review-invites/${token}${tail}`;

describe("headers and markup (token route)", () => {
  for (const [name, token, status] of [["form", tok("rvopen", 1), 200], ["already", tok("rvdone", 1), 200], ["invalid", tok("zznone", 1), 404], ["429", tok("rvlimit", 1), 429], ["503", tok("rvdown", 1), 503]]) {
    test(`${name}: ${status}, no-store, no-referrer, noindex, no analytics, no token in the HTML`, async () => {
      const res = await rawRequest(`/r/${token}`, { headers: { accept: "text/html" } });
      assert.equal(res.status, status);
      assert.deepEqual(res.all("cache-control"), ["no-store"]);
      assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
      assert.deepEqual(res.all("x-robots-tag"), ["noindex, nofollow"]);
      const csp = res.all("content-security-policy");
      assert.equal(csp.length, 1);
      assert.equal(/umami|cloudflareinsights/.test(csp[0]), false, "TOKEN_CSP family: no analytics origins");
      assert.equal(/umami|cloudflareinsights|static\.cloudflare/.test(res.body), false, "no analytics tag in the HTML");
      assert.match(res.body, /<meta name="referrer" content="no-referrer"/);
      assert.match(res.body, /<meta name="robots" content="noindex/);
      assert.equal(res.body.includes(token), false, "the token appears nowhere in the page (canonical, og:url, links)");
      assert.equal([...res.body.matchAll(/<h1[\s>]/g)].length, 1, "one h1");
    });
  }
  test("any method but GET/HEAD: 405 + Allow, and the backend is never called", async () => {
    const token = tok("rvopen", 41);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await rawRequest(`/r/${token}`, { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, "GET, HEAD");
      assert.deepEqual(res.all("cache-control"), ["no-store"]);
    }
    assert.deepEqual(await mockLog((e) => e.path.includes(token)), [], "no upstream request for a refused method");
    const ok = await rawRequest(`/r/${token}`, { method: "HEAD" });
    assert.equal(ok.status, 200, "HEAD still answers");
  });
  test("the invite read forwards the visitor IP in X-Beautica-Client-IP (CF-Connecting-IP does not survive a Workers fetch)", async () => {
    const token = tok("rvopen", 42);
    const res = await rawRequest(`/r/${token}`, { headers: { "cf-connecting-ip": "203.0.113.77" } });
    assert.equal(res.status, 200);
    const calls = callsTo(await mockLog((e) => e.path.includes(token)), "GET", "/review-invites/");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["x-beautica-client-ip"], "203.0.113.77");
  });
  test("the open form allows the API origin, the Turnstile origin and nothing else new", async () => {
    const res = await rawRequest(`/r/${tok("rvopen", 2)}`);
    const csp = res.headers["content-security-policy"];
    assert.ok(csp.includes(`connect-src 'self' ${MOCK_API} https://challenges.cloudflare.com`), csp);
    assert.ok(csp.includes("frame-src https://challenges.cloudflare.com"));
    assert.ok(csp.includes("script-src 'self' https://challenges.cloudflare.com;"));
  });
  test("avatar: only from the configured media origin (evil origin -> no <img>, not in CSP; media origin -> <img> + img-src)", async () => {
    const evil = await rawRequest(`/r/${tok("rvevil", 1)}`);
    assert.equal(evil.status, 200);
    assert.equal(evil.body.includes("evil.example"), false, "no evil URL in the markup");
    assert.equal(evil.headers["content-security-policy"].includes("evil.example"), false, "no evil origin in the CSP");
    const ok = await rawRequest(`/r/${tok("rvavatar", 1)}`);
    assert.ok(ok.body.includes("https://media.beautica.test/a.png"));
    assert.ok(ok.headers["content-security-policy"].includes("img-src 'self' data: https://media.beautica.test"));
  });
  test("unknown, malformed and expired look identical (same status and same body)", async () => {
    const a = await rawRequest(`/r/${tok("zznone", 2)}`);
    const b = await rawRequest("/r/short");
    const c = await rawRequest(`/r/${tok("rvgone", 9)}`.replace("rvgone", "expiredxx"));
    assert.deepEqual([a.status, b.status, c.status], [404, 404, 404]);
    assert.equal(a.body, b.body);
    assert.equal(a.body, c.body);
  });
  test("consumed is a distinct page from invalid", async () => {
    const done = await rawRequest(`/r/${tok("rvdone", 2)}`);
    const bad = await rawRequest(`/r/${tok("zznone", 3)}`);
    assert.match(done.body, /Відгук уже надіслано/);
    assert.equal(done.body.includes("Посилання недійсне"), true, "the hidden invalid screen exists for the island's 404 path");
    assert.notEqual(done.status, bad.status);
  });
  test("trailing slash redirects (307, no-store) and bare /r/ goes home", async () => {
    const r = await rawRequest(`/r/${tok("rvopen", 3)}/`, { headers: { accept: "text/html" } });
    assert.equal(r.status, 307);
    assert.deepEqual(r.all("cache-control"), ["no-store"]);
    assert.equal(r.headers.location, `/r/${tok("rvopen", 3)}`);
    for (const bare of ["/r/", "/r"]) {
      const b = await rawRequest(bare);
      assert.equal(b.status, 307, "a refresh on the replaced address (after a review) goes home, never to a token page");
      assert.equal(b.headers.location, "/");
    }
  });
  test("robots.txt disallows /r/ and the sitemap does not list it", async () => {
    assert.ok((await rawRequest("/robots.txt")).body.split("\n").map((l) => l.trim()).includes("Disallow: /r/"));
    assert.equal((await rawRequest("/sitemap-0.xml")).body.includes("/r"), false);
  });
});

describe("the form", () => {
  test("one service: stars gate the button, submit posts the rating + comment + Turnstile token (action review_submit), success, URL replaced", async () => {
    const token = tok("rvopen", 10);
    const env = await reviewPage(token);
    try {
      const { page } = env;
      assert.equal(await visibleScreen(page), "form");
      assert.match(await text(page.locator("[data-screen=form] .strip")), /Ваш візит до майстра.*Оксана Коваленко.*Манікюр та педикюр.*4\.9.*\(128\)/);
      assert.match(await text(page.locator("[data-screen=form]")), /Інші клієнти побачать ваш відгук як Олена К\. Телефон ніхто не побачить\./);
      assert.equal(await page.locator("#rv-submit").isDisabled(), true);
      const formatRated = await text(page.locator("[data-screen=form] .strip .rate"));
      await rate(page, 0, 4);
      assert.equal(await page.locator("[data-svc] .starbtn[data-v='4']").getAttribute("aria-checked"), "true");
      assert.equal(await page.locator("[data-svc] [data-word]").innerText(), "Добре");
      assert.equal(await page.locator("#rv-submit").isDisabled(), false);
      await page.fill("#comment", "Дуже уважна майстриня!");
      assert.equal(await page.locator("#counter").innerText(), "22 / 2000");
      await page.waitForSelector("#ts-form iframe", { state: "attached", ...SLOW });
      assert.equal((await page.evaluate(() => window.__tsOpts)).action, "review_submit");
      await page.click("#rv-submit");
      await page.waitForSelector("[data-screen=success]:not([hidden])", SLOW);
      assert.equal(await visibleScreen(page), "success");
      assert.match(await text(page.locator("[data-screen=success]")), /Дякуємо за відгук!.*Майстер.*Оксана Коваленко.*24 жовтня 2026 · Манікюр\+гель лак/);
      assert.equal(await text(page.locator("[data-screen=success] .strip .rate")), formatRated, "done card shows the rating exactly as the form strip did, in the shared helper's format");
      assert.equal(formatRated, RATING(4.9, 128));
      assert.equal(new URL(page.url()).pathname, "/r/", "back / refresh cannot reuse the token");
      const posts = callsTo(await mockLog((e) => e.path.includes(token)), "POST", "/reviews");
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].body.items, [{ bookingId: "50000001-1111-4222-8333-944455556666", rating: 4, comment: "Дуже уважна майстриня!" }]);
      assert.match(posts[0].body.turnstileToken, /^TOKEN-/);
      assert.equal(posts[0].headers.authorization, undefined, "no credential but the token in the path");
      assert.equal(posts[0].headers.referer, undefined, "no referrer");
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0, "nothing stored");
      assert.deepEqual(env.analytics, [], "no analytics script");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("two services: a rating each is required; the comment rides on the first only; keyboard arrows move the rating", async () => {
    const token = tok("rvmulti", 1);
    const env = await reviewPage(token);
    try {
      const { page } = env;
      assert.equal(await page.locator("[data-svc]").count(), 2);
      await rate(page, 0, 5);
      assert.equal(await page.locator("#rv-submit").isDisabled(), true, "the second service is still unrated");
      await page.locator("[data-svc]").nth(1).locator(".starbtn[data-v='1']").focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("[data-svc]").nth(1).getAttribute("data-v"), "2");
      assert.equal(await page.locator("#rv-submit").isDisabled(), false);
      await page.fill("#comment", "Все чудово");
      await widgetReady(page, "ts-form");
      await page.click("#rv-submit");
      await page.waitForSelector("[data-screen=success]:not([hidden])", SLOW);
      const posts = callsTo(await mockLog((e) => e.path.includes(token)), "POST", "/reviews");
      assert.deepEqual(posts[0].body.items.map((i) => [i.rating, i.comment ?? null]), [[5, "Все чудово"], [2, null]]);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("two services: the POST body has one item per service, each with ITS OWN bookingId (page order), and the comment only on the first", async () => {
    const token = tok("rvmulti", 2);
    const env = await reviewPage(token);
    try {
      const { page } = env;
      const ids = await page.locator("[data-svc]").evaluateAll((els) => els.map((e) => e.dataset.id));
      assert.equal(ids.length, 2);
      assert.equal(new Set(ids).size, 2, "two different bookings");
      assert.ok(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)), `uuid ids: ${ids}`);
      await rate(page, 0, 3);
      await rate(page, 1, 1);
      await page.fill("#comment", "Коментар на візит");
      await widgetReady(page, "ts-form");
      await page.click("#rv-submit");
      await page.waitForSelector("[data-screen=success]:not([hidden])", SLOW);
      const posts = callsTo(await mockLog((e) => e.path.includes(token)), "POST", "/reviews");
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].body.items, [
        { bookingId: ids[0], rating: 3, comment: "Коментар на візит" },
        { bookingId: ids[1], rating: 1 }, // no comment key at all (the API omits an empty comment)
      ]);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });

  test("salon link: the salon wording and each service shows its master", async () => {
    const env = await reviewPage(tok("rvsalon", 1));
    try {
      const { page } = env;
      assert.match(await text(page.locator("[data-screen=form] .strip")), /Ваш візит до салону.*Салон «Лаванда»/);
      assert.match(await text(page.locator("[data-svc]").nth(1)), /Педикюр класичний.*Ірина Мельник/);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("salon name without the «Салон» prefix keeps the «Салон» caption on the done card", async () => {
    const env = await reviewPage(tok("rvsalonplain", 3));
    try {
      const { page } = env;
      await submitAll(page, 2);
      assert.match(await text(page.locator("[data-screen=success] .strip")), /^Салон Студія «Лаванда» /);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("salon name in capitals («САЛОН …») also drops the duplicate caption on the done card", async () => {
    const env = await reviewPage(tok("rvsalonupper", 4));
    try {
      const { page } = env;
      await submitAll(page, 2);
      assert.match(await text(page.locator("[data-screen=success] .strip")), /^САЛОН «Лаванда» /);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("salon link, done card: salon caption, salon name, the services line, and the rating exactly as the form strip showed it", async () => {
    const env = await reviewPage(tok("rvsalon", 2));
    try {
      const { page } = env;
      const formRate = await text(page.locator("[data-screen=form] .strip .rate"));
      await submitAll(page, 2);
      const strip = page.locator("[data-screen=success] .strip");
      assert.match(await text(strip), /^Салон «Лаванда» Манікюр\+гель лак, Педикюр класичний /);
      assert.equal(await text(strip.locator(".rate")), formRate);
      assert.equal(formRate, RATING(4.9, 128));
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("done card avatar: the img src is on the media origin (and only then)", async () => {
    const env = await reviewPage(tok("rvavatar", 2));
    try {
      const { page } = env;
      await submitAll(page, 1);
      const src = await page.locator("[data-screen=success] .strip .disc img").getAttribute("src");
      assert.ok(src?.startsWith("https://media.beautica.test/"), `avatar src: ${src}`);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("a provider with no reviews (avgRating absent, reviewCount 0): the card renders cleanly, no rating cluster, no count, no NaN", async () => {
    const env = await reviewPage(tok("rvnorate", 1));
    try {
      const { page } = env;
      assert.equal(await visibleScreen(page), "form");
      const strip = await text(page.locator("[data-screen=form] .strip"));
      assert.match(strip, /Ваш візит до майстра.*Оксана Коваленко.*Манікюр\+гель лак$/);
      assert.equal(await page.locator("[data-screen=form] .strip .rate").count(), 0);
      assert.equal(/NaN|undefined|null|\(0\)/.test(strip), false, strip);
      const box = await page.locator("[data-screen=form] .strip").boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0);
      await submitAll(page, 1);
      assert.equal(await page.locator("[data-screen=success] .strip").count(), 1, "the done card still shows the master strip");
      assert.equal(await page.locator("[data-screen=success] .strip .rate").count(), 0, "no rating cluster on the done card either");
      assert.equal(/NaN|undefined|null|\(0\)/.test(await text(page.locator("[data-screen=success]"))), false);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("submit failures and the other states", () => {
  const fill = async (page) => {
    await rate(page, 0, 5);
    await widgetReady(page, "ts-form");
    await page.click("#rv-submit");
  };
  test("429: the retry banner, the form stays, the button works again", async () => {
    const env = await reviewPage(tok("rvslow", 1));
    try {
      const { page } = env;
      await fill(page);
      await page.waitForSelector("#rv-error", { state: "visible", ...SLOW });
      assert.equal(await text(page.locator("#rv-error")), "Забагато спроб. Спробуйте за кілька хвилин.");
      assert.equal(await visibleScreen(page), "form");
      assert.equal(await page.locator("#rv-submit").isDisabled(), false);
      assert.notEqual(new URL(page.url()).pathname, "/r/", "the token stays usable");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("400: the validation banner", async () => {
    const env = await reviewPage(tok("rvbad", 1));
    try {
      const { page } = env;
      await fill(page);
      await page.waitForSelector("#rv-error", { state: "visible", ...SLOW });
      assert.match(await text(page.locator("#rv-error")), /Перевірте оцінки/);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("network failure: the connection banner, nothing lost", async () => {
    const token = tok("rvopen", 20);
    const env = await reviewPage(token);
    try {
      const { page } = env;
      await page.route(`${MOCK_API}${POST_API(token, "/reviews")}`, (r) => r.abort("failed"));
      await page.fill("#comment", "Текст");
      await fill(page);
      await page.waitForSelector("#rv-error", { state: "visible", ...SLOW });
      assert.equal(await text(page.locator("#rv-error")), "Не вдалося надіслати відгук. Перевірте інтернет і спробуйте ще раз.");
      assert.equal(await page.inputValue("#comment"), "Текст");
      assert.equal(await page.locator("#rv-submit").isDisabled(), false);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("409: the distinct «already reviewed» screen; 404: the neutral invalid screen", async () => {
    for (const [kind, screen, h] of [["rvconf", "already", "Відгук уже надіслано"], ["rvgone", "invalid", "Посилання недійсне або вже використане"]]) {
      const env = await reviewPage(tok(kind, 1));
      try {
        const { page } = env;
        await fill(page);
        await page.waitForSelector(`[data-screen=${screen}]:not([hidden])`, SLOW);
        assert.equal(await text(page.locator(`[data-screen=${screen}] [role=status]`)), h);
        assert.equal(await page.locator("[data-screen=form]").isHidden(), true);
        assert.equal(new URL(page.url()).pathname, "/r/", "the dead token is scrubbed from the address");
        quiet(env);
      } finally {
        await env.context.close();
      }
    }
  });
  test("409 BOOKING_UNAVAILABLE on a REVIEW call is a plain conflict («already reviewed»), never the provider-unavailable banner", async () => {
    const env = await reviewPage(tok("rvblk", 1));
    try {
      const { page } = env;
      await fill(page);
      await page.waitForSelector("[data-screen=already]:not([hidden])", SLOW);
      assert.equal(await page.locator("[data-screen=form]").isHidden(), true);
      assert.equal(new URL(page.url()).pathname, "/r/", "the dead token is scrubbed from the address");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("already / invalid pages render server-side with a visible box", async () => {
    for (const [token, h] of [[tok("rvdone", 3), "Відгук уже надіслано"], [tok("zznone", 4), "Посилання недійсне або вже використане"]]) {
      const env = await reviewPage(token);
      try {
        const box = await env.page.locator("h1").boundingBox();
        assert.ok(box && box.width > 0 && box.height > 0);
        assert.equal(await text(env.page.locator("h1")), h);
        if (h === "Відгук уже надіслано") await env.page.waitForFunction(() => location.pathname === "/r/", null, { timeout: 5000 });
        quiet(env);
      } finally {
        await env.context.close();
      }
    }
  });
  test("already reviewed, JavaScript OFF: the server alone renders the distinct screen (status text, no form, no stars, no submit), nothing is posted", async () => {
    const token = tok("rvdone", 5);
    const env = await reviewPage(token, { js: false });
    try {
      const { page } = env;
      assert.equal(env.res.status(), 200);
      assert.equal(await text(page.locator("h1")), "Відгук уже надіслано");
      assert.match(await text(page.locator("[data-review-root]")), /Ви вже залишили відгук за цим посиланням\. Дякуємо!/);
      assert.equal(await visibleScreen(page), "already");
      assert.equal(await page.locator("[data-screen=form]").count(), 0, "no form is rendered for a consumed token");
      assert.equal(await page.locator(".starbtn:visible, #rv-submit:visible, #comment:visible").count(), 0);
      assert.equal(await page.locator("a.cta2, a.cta").first().isVisible(), true, "a way home");
      assert.deepEqual(await mockLog((e) => e.path.includes(token) && e.method !== "GET"), [], "nothing but the read reaches the backend");
    } finally {
      await env.context.close();
    }
  });
  test("429 / 503 on the read: the retry notice", async () => {
    for (const [token, status] of [[tok("rvlimit", 2), 429], [tok("rvdown", 2), 503]]) {
      const env = await reviewPage(token);
      try {
        assert.equal(env.res.status(), status);
        assert.equal(await text(env.page.locator("h1")), "Сторінка тимчасово недоступна");
        assert.equal(await env.page.locator("a.cta").count(), 1);
      } finally {
        await env.context.close();
      }
    }
  });
});

describe("opt-out", () => {
  test("link -> confirm (Turnstile) -> POST opt-out -> done; «Залишити відгук» goes back with the ratings kept", async () => {
    const token = tok("rvopen", 30);
    const env = await reviewPage(token);
    try {
      const { page } = env;
      await rate(page, 0, 3);
      await page.click("#rv-optout");
      assert.equal(await visibleScreen(page), "optout-confirm");
      assert.match(await text(page.locator("[data-screen=optout-confirm]")), /Більше не надсилати\?.*Записи й нагадування це не змінить\./);
      await page.click("#rv-optout-back");
      assert.equal(await visibleScreen(page), "form");
      assert.equal(await page.locator("[data-svc]").first().getAttribute("data-v"), "3");
      await page.click("#rv-optout");
      await page.waitForSelector("#ts-optout iframe", { state: "attached", ...SLOW });
      await page.click("#rv-optout-yes");
      await page.waitForSelector("[data-screen=optout-done]:not([hidden])", SLOW);
      assert.equal(await text(page.locator("[data-screen=optout-done] [role=status]")), "Готово");
      assert.equal(new URL(page.url()).pathname, "/r/", "opt-out success scrubs the token");
      const posts = callsTo(await mockLog((e) => e.path.includes(token)), "POST", "/opt-out");
      assert.equal(posts.length, 1);
      assert.match(posts[0].body.turnstileToken, /^TOKEN-/);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("429 on opt-out: a banner, the confirm screen stays", async () => {
    const env = await reviewPage(tok("rvslow", 5));
    try {
      const { page } = env;
      await page.click("#rv-optout");
      await page.waitForSelector("#ts-optout iframe", { state: "attached", ...SLOW }); // the widget must be mounted before «Так», as in the happy-path test (a slow runner raced it)
      await page.click("#rv-optout-yes");
      await page.waitForSelector("#rv-optout-error", { state: "visible", ...SLOW });
      assert.equal(await text(page.locator("#rv-optout-error")), "Забагато спроб. Спробуйте за кілька хвилин.");
      assert.equal(await visibleScreen(page), "optout-confirm");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("opt-out confirm: button stack spacing", () => {
  // The accent button's extruded shadow painted over its neighbour when the stack gap was 4px (`stack tight`); the confirm screen uses `form-stack` (--vt-space-md = 16px).
  for (const width of [360, 1280]) {
    test(`${width}px: #rv-optout-yes and #rv-optout-back do not overlap, are >= 16px apart and >= 48px tall`, async () => {
      const env = await reviewPage(tok("rvmulti", 70 + width), { width, height: 900 });
      try {
        const { page } = env;
        await page.click("#rv-optout");
        assert.equal(await visibleScreen(page), "optout-confirm");
        const yes = await page.locator("#rv-optout-yes").boundingBox();
        const back = await page.locator("#rv-optout-back").boundingBox();
        assert.ok(yes && back && yes.height > 0 && back.height > 0, "both buttons have a box");
        const gap = back.y - (yes.y + yes.height);
        assert.ok(gap >= 16, `vertical gap between the buttons is ${gap}px (< 16px: the accent shadow covers the neighbour)`);
        assert.ok(yes.height >= 48 && back.height >= 48, `targets >= 48px (got ${yes.height} / ${back.height})`);
        quiet(env);
      } finally {
        await env.context.close();
      }
    });
  }
});

describe("opt-out failure branches", () => {
  const toConfirm = async (token) => {
    const env = await reviewPage(token);
    await env.page.click("#rv-optout");
    await widgetReady(env.page, "ts-optout");
    return env;
  };
  test("404 on opt-out (token spent or expired meanwhile): the neutral invalid screen and the dead token is scrubbed from the address", async () => {
    const token = tok("rvoptgone", 60);
    const env = await toConfirm(token);
    try {
      const { page } = env;
      assert.notEqual(new URL(page.url()).pathname, "/r/", "the token is still in the address before the request");
      await page.click("#rv-optout-yes");
      await page.waitForSelector("[data-screen=invalid]:not([hidden])", SLOW);
      assert.equal(await text(page.locator("[data-screen=invalid] [role=status]")), "Посилання недійсне або вже використане");
      assert.equal(await page.locator("[data-screen=optout-done]").isHidden(), true, "never claims success");
      assert.equal(new URL(page.url()).pathname, "/r/", "the dead token is scrubbed from the address");
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0);
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
  test("network failure on opt-out: the error banner, the confirm screen stays, the token stays usable, the button works again", async () => {
    const token = tok("rvopen", 61);
    const env = await toConfirm(token);
    try {
      const { page } = env;
      await page.route(`${MOCK_API}${POST_API(token, "/opt-out")}`, (r) => r.abort("failed"));
      await page.click("#rv-optout-yes");
      await page.waitForSelector("#rv-optout-error", { state: "visible", ...SLOW });
      assert.equal(await text(page.locator("#rv-optout-error")), "Не вдалося виконати. Перевірте інтернет і спробуйте ще раз.");
      assert.equal(await visibleScreen(page), "optout-confirm");
      assert.equal(await page.locator("#rv-optout-yes").isDisabled(), false);
      assert.notEqual(new URL(page.url()).pathname, "/r/", "a failed opt-out does not burn the token");
      quiet(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("responsive", () => {
  for (const width of [360, 768, 1280]) {
    test(`${width}px: every state has non-zero boxes, no sideways scroll, targets >= 48 px`, async () => {
      const env = await reviewPage(tok("rvmulti", 50 + width), { width, height: 900 });
      try {
        const { page } = env;
        const ok = async (sel) => {
          const b = await page.locator(sel).first().boundingBox();
          assert.ok(b && b.width > 0 && b.height > 0, `${sel} at ${width}px`);
          return b;
        };
        const noScroll = async (where) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${where}: no horizontal scroll at ${width}px`);
        for (const sel of ["[data-screen=form] .strip", "[data-svc]", ".starbtn", "#comment", "#rv-submit", "#rv-optout"]) await ok(sel);
        const star = await ok(".starbtn");
        assert.ok(star.width >= 48 && star.height >= 48, "star target >= 48 px");
        assert.ok((await ok("#rv-optout")).height >= 48);
        const glyph = await page.locator(".starbtn svg").first().boundingBox();
        assert.ok(glyph && glyph.width > 0, "the star glyph is drawn");
        await noScroll("form");
        await rate(page, 0, 5);
        await rate(page, 1, 4);
        await page.fill("#comment", "x".repeat(2000));
        await noScroll("form filled");
        await shot(page, `review-form-${width}`);
        await page.click("#rv-optout");
        await ok("#rv-optout-yes");
        await noScroll("opt-out confirm");
        await page.click("#rv-optout-back");
        await widgetReady(page, "ts-form");
        await page.click("#rv-submit");
        await page.waitForSelector("[data-screen=success]:not([hidden])", SLOW);
        await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-screen=success] .reveal")).opacity === "1");
        await ok(".medallion");
        await ok("[data-screen=success] .cta2");
        await noScroll("success");
        await shot(page, `review-success-${width}`);
        quiet(env);
      } finally {
        await env.context.close();
      }
    });
  }
});

describe("fonts ahead of the first paint (audit cycle 2)", () => {
  for (const token of [tok("rvopen", 90), tok("zznone", 90)])
    test(`${token.slice(0, 6)}: no Latin letters on the page, so 4 font files / <= 110 KB and the big Latin files are never requested`, async () => {
      const env = await reviewPage(token);
      try {
        // Distinct files keyed by name: a font fetched twice (late first-load response, reload refetch) counts once.
        const byFile = new Map();
        const pending = [];
        env.page.on("response", (r) => {
          if (!/\.woff2(\?|$)/.test(r.url())) return;
          const file = new URL(r.url()).pathname.split("/").pop();
          pending.push(r.body().catch(() => Buffer.alloc(0)).then((b) => { byFile.set(file, Math.max(byFile.get(file) ?? 0, b.length)); }));
        });
        await env.page.reload({ waitUntil: "networkidle" });
        await env.page.evaluate(() => document.fonts.ready);
        await env.page.waitForLoadState("networkidle");
        await Promise.all(pending);
        const files = [...byFile.keys()].sort();
        const total = [...byFile.values()].reduce((n, b) => n + b, 0);
        assert.deepEqual(files.filter((f) => /^(nunito|comfortaa)-latin-wght/.test(f)), [], "a visible Latin letter (e.g. SMS) pulls the full Latin face");
        assert.ok(files.length <= 4, `${files.length} font files: ${files.join(", ")}`);
        assert.ok(total <= 110 * 1024, `fonts <= 110 KB (got ${total} B: ${files.join(", ")})`);
      } finally {
        await env.context.close();
      }
    });
});
