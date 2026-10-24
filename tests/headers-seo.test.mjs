// Per-route status, security headers (exactly once), cache/robots on token routes, rewrites, SEO tags, robots.txt, sitemap,
// assetlinks. Served by `wrangler dev` so public/_headers and public/_redirects are applied exactly as on Cloudflare.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rawRequest, TOKEN, requireBase, MOCK_API } from "./helpers/env.mjs";

requireBase();

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.beautica.app; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
const STATIC_SECURITY = {
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};
const decode = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
const meta = (html, re) => (html.match(re)?.[1] ? decode(html.match(re)[1]) : null);
const strip = (s) => decode(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** Indexable pages: exact title / description / canonical / H1. */
const PAGES = [
  { path: "/", title: "Beautica — скоро в Google Play та App Store", description: "Beautica — пошук і запис до майстрів краси. Скоро в Google Play та App Store.", canonical: "https://beautica.app/", h1: "Beautica" },
  { path: "/privacy", title: "Політика конфіденційності — Beautica", description: "Які персональні дані збирає Beautica, навіщо, кому їх передає, скільки зберігає та як реалізувати свої права, зокрема для гостьового запису.", canonical: "https://beautica.app/privacy", h1: "Політика конфіденційності" },
  { path: "/terms", title: "Умови користування — Beautica", description: "Правила користування Beautica: акаунти, записи та скасування, відгуки, фото, заборонені дії, відповідальність і право, що застосовується.", canonical: "https://beautica.app/terms", h1: "Умови користування" },
  { path: "/support", title: "Підтримка Beautica — як з нами зв'язатися", description: "Напишіть у підтримку Beautica: електронна пошта, форма в застосунку, що вказати у листі, а також контакти для питань про персональні дані.", canonical: "https://beautica.app/support", h1: "Підтримка" },
  { path: "/delete-account", title: "Видалення акаунта Beautica — як подати запит", description: "Як видалити акаунт Beautica в застосунку або без нього, які дані видаляються, що залишається і на який строк. Для гостей без акаунта теж.", canonical: "https://beautica.app/delete-account", h1: "Видалення акаунта" },
];

/** Token routes: the URL is the credential. `real` is the URL the backend e-mails; the shell is what the rewrite serves. */
const TOKEN_ROUTES = [
  { real: "/invite/accept?token=abc123", shell: "/l/invite", title: "Запрошення до Beautica", h1: "Вас запросили до Beautica" },
  { real: `/bookings/${TOKEN}`, shell: "/l/booking", title: "Ваш запис у Beautica", h1: "Ваш запис у Beautica" },
  { real: `/bookings/${TOKEN}/review`, shell: "/l/review", title: "Залиште відгук — Beautica", h1: "Залиште відгук" },
  { real: `/book/cancel/${TOKEN}`, shell: "/l/cancel", title: "Скасування запису — Beautica", h1: "Скасування запису" },
];

describe("indexable pages", () => {
  for (const p of PAGES) {
    describe(p.path, async () => {
      const res = await rawRequest(p.path);
      test("200 HTML with every security header exactly once", () => {
        assert.equal(res.status, 200);
        assert.match(res.headers["content-type"], /^text\/html/);
        for (const [k, v] of Object.entries(STATIC_SECURITY)) assert.deepEqual(res.all(k), [v], k);
        assert.deepEqual(res.all("referrer-policy"), ["strict-origin-when-cross-origin"], "Referrer-Policy must be sent exactly once");
      });
      test("is not marked no-store / noindex by headers", () => {
        assert.notEqual(res.headers["cache-control"], "no-store");
        assert.equal(res.headers["x-robots-tag"], undefined);
      });
      test("title, description, canonical, robots and the single H1 are exact", () => {
        assert.equal(meta(res.body, /<title>([^<]*)<\/title>/), p.title);
        assert.equal(meta(res.body, /<meta name="description" content="([^"]*)"/), p.description);
        assert.equal(meta(res.body, /<link rel="canonical" href="([^"]*)"/), p.canonical);
        assert.equal(meta(res.body, /<meta name="robots" content="([^"]*)"/), "index, follow");
        const h1s = [...res.body.matchAll(/<h1[\s>][\s\S]*?<\/h1>/g)];
        assert.equal(h1s.length, 1, "exactly one <h1>");
        assert.equal(strip(h1s[0][0]), p.h1);
        assert.equal(meta(res.body, /<html lang="([^"]*)"/), "uk");
      });
      test("carries Open Graph + Twitter tags pointing at the canonical", () => {
        assert.equal(meta(res.body, /<meta property="og:url" content="([^"]*)"/), p.canonical);
        assert.equal(meta(res.body, /<meta property="og:image" content="([^"]*)"/), "https://beautica.app/og-default.png");
        assert.equal(meta(res.body, /<meta name="twitter:card" content="([^"]*)"/), "summary_large_image");
      });
    });
  }
});

describe("token routes (real e-mail URL -> 200 rewrite -> noindex shell)", () => {
  for (const r of TOKEN_ROUTES) {
    describe(r.real.replace(TOKEN, ":id"), async () => {
      const res = await rawRequest(r.real);
      const direct = await rawRequest(r.shell);
      test("is a 200 rewrite (no redirect, address bar keeps the token URL)", () => {
        assert.equal(res.status, 200);
        assert.equal(res.headers.location, undefined);
        // The guest cancel link is served by the Worker with the runtime API origin in data-api (src/pages/book/cancel/[token].ts).
        const norm = (b) => b.replace(/(id="cancel-root"[^>]*?\sdata-api=")[^"]*"/, '$1"');
        assert.equal(norm(res.body), norm(direct.body), "the rewrite must serve the shell page byte for byte");
      });
      test("serves the right shell", () => {
        assert.equal(meta(res.body, /<title>([^<]*)<\/title>/), r.title);
        assert.equal(strip(res.body.match(/<h1[\s>][\s\S]*?<\/h1>/)[0]), r.h1);
      });
      for (const [label, target] of [["rewritten URL", res], ["shell URL", direct]]) {
        test(`${label}: no-referrer exactly once, no-store, noindex header`, () => {
          assert.deepEqual(target.all("referrer-policy"), ["no-referrer"]);
          assert.deepEqual(target.all("cache-control"), ["no-store"]);
          assert.deepEqual(target.all("x-robots-tag"), ["noindex, nofollow"]);
          for (const [k, v] of Object.entries(STATIC_SECURITY)) {
            const expected = k === "content-security-policy" && r.shell === "/l/cancel" && target === res ? v.replace("https://api.beautica.app", MOCK_API) : v;
            assert.deepEqual(target.all(k), [expected], k);
          }
        });
      }
      test("page is noindex, has no canonical and sets <meta name=referrer>", () => {
        assert.equal(meta(res.body, /<meta name="robots" content="([^"]*)"/), "noindex, nofollow");
        assert.equal(meta(res.body, /<meta name="referrer" content="([^"]*)"/), "no-referrer");
        assert.equal(/rel="canonical"/.test(res.body), false);
        assert.equal(/property="og:/.test(res.body), false);
      });
    });
  }

  test("a path under a token prefix with no matching rewrite is not a token page (404, still hardened)", async () => {
    const res = await rawRequest("/bookings");
    assert.equal(res.status, 404);
    assert.deepEqual(res.all("x-content-type-options"), ["nosniff"]);
  });
});

describe("404", () => {
  test("an unknown path answers 404 with the noindex 404 page and one Referrer-Policy", async () => {
    const res = await rawRequest("/definitely-not-a-page");
    assert.equal(res.status, 404);
    assert.equal(meta(res.body, /<title>([^<]*)<\/title>/), "Сторінку не знайдено — Beautica");
    assert.equal(meta(res.body, /<meta name="robots" content="([^"]*)"/), "noindex, nofollow");
    assert.equal(strip(res.body.match(/<h1[\s>][\s\S]*?<\/h1>/)[0]), "Сторінку не знайдено");
    assert.deepEqual(res.all("referrer-policy"), ["strict-origin-when-cross-origin"]);
    assert.deepEqual(res.all("content-security-policy"), [CSP]);
    assert.equal(res.all("permissions-policy").length, 1);
    assert.deepEqual(res.all("strict-transport-security"), ["max-age=31536000; includeSubDomains"]);
    assert.deepEqual(res.all("x-content-type-options"), ["nosniff"]);
  });

  test("/404 direct serves the same page (200 accepted) with meta noindex; no X-Robots-Tag is asserted on 404s", async () => {
    const res = await rawRequest("/404");
    assert.ok([200, 404].includes(res.status));
    assert.equal(meta(res.body, /<meta name="robots" content="([^"]*)"/), "noindex, nofollow");
    assert.deepEqual(res.all("content-security-policy"), [CSP]);
  });
});

describe("legal date label", () => {
  for (const [path, label] of [["/privacy", "Дата набрання чинності"], ["/terms", "Дата набрання чинності"], ["/support", "Оновлено"], ["/delete-account", "Оновлено"]]) {
    test(`${path} shows «${label}»`, async () => {
      const res = await rawRequest(path);
      assert.match(res.body, new RegExp(`<span[^>]*>${label}: <time`));
    });
  }
});

describe("home JSON-LD", () => {
  test("/ carries valid Organization + WebSite JSON-LD (no MobileApplication until the app is live)", async () => {
    const res = await rawRequest("/");
    const blocks = [...res.body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const types = blocks.map((b) => b["@type"]);
    assert.deepEqual(types, ["Organization", "WebSite"]);
    const [org, site] = blocks;
    assert.equal(org.name, "Beautica");
    assert.equal(org.url, "https://beautica.app/");
    assert.equal(org.logo, "https://beautica.app/icon-192.png");
    assert.equal("sameAs" in org, false);
    assert.equal(site.url, "https://beautica.app/");
    assert.equal(JSON.stringify(site).includes("SearchAction"), false);
  });
});

describe("endpoint and well-known", () => {
  test("/.well-known/assetlinks.json is 200 JSON (an array), directly, cacheable for an hour", async () => {
    const res = await rawRequest("/.well-known/assetlinks.json");
    assert.equal(res.status, 200);
    assert.equal(res.headers.location, undefined);
    assert.match(res.headers["content-type"], /^application\/json/);
    assert.deepEqual(res.all("cache-control"), ["public, max-age=3600"]);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  test("/api/delete-request GET is 405 (never a cached page)", async () => {
    const res = await rawRequest("/api/delete-request");
    assert.equal(res.status, 405);
    assert.deepEqual(res.all("cache-control"), ["no-store"]);
  });

  test("built assets are immutable", async () => {
    const home = await rawRequest("/");
    const asset = home.body.match(/href="(\/_astro\/[^"]+\.woff2)"/)[1];
    const res = await rawRequest(asset);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /font\/woff2/);
    assert.match(res.all("cache-control").join(","), /max-age=31536000.*immutable/);
  });

  test("/email/* assets are cacheable for a day", async () => {
    const res = await rawRequest("/email/logo.png");
    assert.equal(res.status, 200);
    assert.deepEqual(res.all("cache-control"), ["public, max-age=86400"]);
  });
});

describe("crawlers", () => {
  test("robots.txt allows the site, blocks every token prefix and /api/, points at the sitemap", async () => {
    const res = await rawRequest("/robots.txt");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/plain/);
    const lines = res.body.split("\n").map((l) => l.trim());
    for (const l of ["User-agent: *", "Allow: /", "Disallow: /l/", "Disallow: /invite/", "Disallow: /bookings/", "Disallow: /book/cancel/", "Disallow: /api/", "Sitemap: https://beautica.app/sitemap-index.xml"]) {
      assert.ok(lines.includes(l), `robots.txt lacks "${l}"`);
    }
  });

  test("sitemap lists exactly the 5 indexable pages and no token shell or 404", async () => {
    const index = await rawRequest("/sitemap-index.xml");
    assert.equal(index.status, 200);
    assert.match(index.body, /<loc>https:\/\/beautica\.app\/sitemap-0\.xml<\/loc>/);
    const map = await rawRequest("/sitemap-0.xml");
    const locs = [...map.body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]).sort();
    assert.deepEqual(locs, PAGES.map((p) => p.canonical).sort());
    for (const bad of ["/l/", "/404", "/invite", "/bookings", "/book/", "/api/"]) assert.equal(map.body.includes(bad), false, `sitemap lists ${bad}`);
  });
});

describe("the salon wizard fragment /book-steps/salon (phase 016)", () => {
  test("revalidated on every use (never a stale copy against new scripts), noindex, security headers once", async () => {
    const res = await rawRequest("/book-steps/salon");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "public, max-age=0, must-revalidate");
    assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
    for (const [k, v] of Object.entries(STATIC_SECURITY)) assert.equal(res.headers[k], v, k);
  });
});
