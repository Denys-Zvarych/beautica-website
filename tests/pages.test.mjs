// Every page renders at 360 and 1280 px: single visible H1, no console / page / request errors, nothing leaves localhost.
// Plus page behaviour: legal contents list (<details> closed on phones, open from 600 px) and the Android-only «open in app».
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open, mockCancelApi, visibleBox } from "./helpers/browser.mjs";
import { BASE, TOKEN, uk, requireBase } from "./helpers/env.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const ROUTES = [
  { path: "/", h1: "Beautica" },
  { path: "/privacy", h1: "Політика конфіденційності" },
  { path: "/terms", h1: "Умови користування" },
  { path: "/support", h1: "Підтримка" },
  { path: "/delete-account", h1: "Видалення акаунта" },
  { path: "/not-a-real-page", h1: "Сторінку не знайдено", status: 404 },
  { path: "/invite/accept?token=abc123", h1: "Вас запросили до Beautica", openInApp: true },
  { path: `/bookings/${TOKEN}`, h1: "Ваш запис у Beautica", openInApp: true },
  { path: `/bookings/${TOKEN}/review`, h1: "Залиште відгук", openInApp: true },
  { path: `/book/cancel/${TOKEN}`, h1: "Скасування запису", cancel: true },
];

describe("render probe", () => {
  for (const width of [360, 1280]) {
    for (const r of ROUTES) {
      test(`${r.path.replace(TOKEN, ":id")} @${width}: H1 «${r.h1}» visible, no errors, no external requests`, async () => {
        const { context, page, external, problems, analytics } = await open(browser, { width });
        try {
          if (r.cancel) await mockCancelApi(context, { get: () => ({ status: 404 }) });
          const res = await page.goto(BASE + r.path, { waitUntil: "load" });
          assert.equal(res.status(), r.status ?? 200);
          const h1 = page.getByRole("heading", { level: 1 });
          assert.equal(await h1.count(), 1);
          // The cancel page has ONE h1 whose text is the state's: «Скасування запису» while loading, then the state's own heading (below).
          if (!r.cancel) assert.equal((await h1.innerText()).replace(/\s+/g, " ").trim().startsWith(r.h1), true);
          assert.ok(await visibleBox(h1), "H1 has no box");
          assert.ok(await visibleBox(page.getByRole("main")), "<main> has no box");
          assert.ok(await visibleBox(page.getByRole("contentinfo")), "footer has no box");
          if (r.cancel) await page.locator("#st-notfound").waitFor({ state: "visible" }); // wait for the fetch to settle, not a sleep
          if (r.cancel) {
            assert.equal(await h1.count(), 1);
            assert.equal((await h1.innerText()).trim(), uk.cancel.notfoundTitle, "the one h1 is the heading of the state shown, no stacked second title");
            assert.equal(await page.getByRole("heading", { level: 2 }).count(), 0);
          }
          // Chromium logs the 404 status itself as a console error: that single line is the expected one (the 404 page, the mocked API 404).
          const expected404 = r.status === 404 || r.cancel ? [`console: Failed to load resource: the server responded with a status of 404 (Not Found)`] : [];
          assert.deepEqual(problems, expected404);
          assert.deepEqual(external, [], "page tried to reach a non-local origin");
          // Phase 007: token routes carry no analytics tag (nothing requested); the 404 page does (Umami + Cloudflare beacon).
          const isToken = /^\/(invite|bookings|book\/cancel)\//.test(r.path);
          if (isToken) await page.waitForTimeout(1500); // longer than the idle injection takes: a token page must still have asked for nothing
          else for (let i = 0; i < 50 && analytics.length < 2; i++) await page.waitForTimeout(100); // injected after load + idle
          assert.equal(analytics.length, isToken ? 0 : 2, `analytics requests: ${analytics}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 0, `horizontal scroll: ${overflow}px`);
        } finally {
          await context.close();
        }
      });
    }
  }
});

describe("CSP in the browser", () => {
  test("an injected inline script and an injected external script are both blocked", async () => {
    const { context, page, problems } = await open(browser, { width: 360 });
    try {
      await page.goto(BASE + "/");
      const blocked = page.waitForEvent("console", { predicate: (m) => /evil\.example/.test(m.text()), timeout: 5000 });
      await page.evaluate(() => {
        const inline = document.createElement("script");
        inline.textContent = "window.__pwned = 'inline'";
        document.body.append(inline);
        const ext = document.createElement("script");
        ext.src = "https://evil.example/x.js";
        document.body.append(ext);
      });
      await blocked;
      assert.equal(await page.evaluate(() => window.__pwned), undefined, "inline script ran: script-src 'self' is not enforced");
      assert.ok(problems.some((p) => /Content Security Policy/.test(p) && /script/i.test(p)), `no script CSP violation logged: ${problems}`);
    } finally {
      await context.close();
    }
  });
});

describe("legal contents list (<details>)", () => {
  for (const path of ["/privacy", "/terms", "/support", "/delete-account"]) {
    describe(path, () => {
      test("360 px: closed by default, summary is a control that opens it", async () => {
        const { context, page } = await open(browser, { width: 360 });
        try {
          await page.goto(BASE + path);
          const details = page.locator("details.toc-details");
          const summary = details.locator("summary");
          await details.waitFor({ state: "attached" });
          assert.equal(await details.evaluate((d) => d.open), false);
          assert.ok(await visibleBox(summary));
          assert.equal(await summary.getAttribute("tabindex"), null);
          assert.equal(await details.getByRole("link").first().isVisible(), false, "links are hidden while closed");
          await summary.click();
          assert.equal(await details.evaluate((d) => d.open), true);
          assert.ok(await details.getByRole("link").first().isVisible());
          await summary.click();
          assert.equal(await details.evaluate((d) => d.open), false, "a second tap closes it");
        } finally {
          await context.close();
        }
      });

      test("1280 px: permanently open, summary is inert and cannot close it", async () => {
        const { context, page } = await open(browser, { width: 1280, height: 900 });
        try {
          await page.goto(BASE + path);
          const details = page.locator("details.toc-details");
          const summary = details.locator("summary");
          await details.waitFor({ state: "attached" });
          assert.equal(await details.evaluate((d) => d.open), true);
          assert.equal(await summary.getAttribute("tabindex"), "-1");
          assert.ok(await details.getByRole("link").first().isVisible());
          await summary.click({ force: true });
          assert.equal(await details.evaluate((d) => d.open), true, "clicking the heading must not collapse the list");
        } finally {
          await context.close();
        }
      });
    });
  }

  test("breakpoint is 600 px: 599 closed, 600 open, and it follows a live resize", async () => {
    const { context, page } = await open(browser, { width: 599 });
    try {
      await page.goto(BASE + "/privacy");
      const details = page.locator("details.toc-details");
      assert.equal(await details.evaluate((d) => d.open), false);
      await page.setViewportSize({ width: 600, height: 800 });
      await page.waitForFunction(() => document.querySelector("details.toc-details").open === true);
      await page.setViewportSize({ width: 599, height: 800 });
      await page.waitForFunction(() => document.querySelector("details.toc-details").open === false);
    } finally {
      await context.close();
    }
  });

  test("contents links jump to a heading that exists", async () => {
    const { context, page } = await open(browser, { width: 1280, height: 900 });
    try {
      await page.goto(BASE + "/privacy");
      const hrefs = await page.locator("details.toc-details nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      assert.ok(hrefs.length >= 5, "privacy policy should list its sections");
      for (const h of hrefs) assert.equal(await page.locator(h.replace("#", "#")).count(), 1, `no element ${h}`);
    } finally {
      await context.close();
    }
  });
});

describe("open in app (Android only)", () => {
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const PKG = "com.beautica.beautica_mobile";

  for (const r of ROUTES.filter((x) => x.openInApp)) {
    const label = r.path.replace(TOKEN, ":id");
    test(`${label}: Android sees the button with an intent:// URL for the exact address-bar path`, async () => {
      const { context, page } = await open(browser, { userAgent: ANDROID, isMobile: true });
      try {
        await page.goto(BASE + r.path);
        const btn = page.getByRole("link", { name: uk.appLink.openInApp });
        await btn.waitFor({ state: "visible" });
        assert.ok(await visibleBox(btn));
        assert.equal(await btn.getAttribute("href"), `intent://beautica.app${r.path}#Intent;scheme=https;package=${PKG};end`);
      } finally {
        await context.close();
      }
    });

    for (const [name, ua] of [["iPhone", IPHONE], ["desktop", DESKTOP]]) {
      test(`${label}: ${name} does not get the button (intent:// would do nothing)`, async () => {
        const { context, page } = await open(browser, { userAgent: ua });
        try {
          await page.goto(BASE + r.path);
          const btn = page.locator("#open-in-app");
          assert.equal(await btn.count(), 1);
          assert.equal(await btn.isVisible(), false);
          assert.equal(await btn.getAttribute("href"), "#", "no intent URL is built for non-Android");
          assert.equal(await page.getByText(uk.appLink.noApp).isVisible(), true, "fallback text still shown");
        } finally {
          await context.close();
        }
      });
    }
  }

  test("the guest cancel page has no «open in app» button, even on Android", async () => {
    const { context, page } = await open(browser, { userAgent: ANDROID, isMobile: true });
    try {
      await mockCancelApi(context, { get: () => ({ status: 404 }) });
      await page.goto(BASE + `/book/cancel/${TOKEN}`);
      await page.locator("#st-notfound").waitFor({ state: "visible" });
      assert.equal(await page.locator("#open-in-app").count(), 0);
    } finally {
      await context.close();
    }
  });
});
