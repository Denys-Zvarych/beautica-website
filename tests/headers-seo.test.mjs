// Per-route status, security headers (exactly once), cache/robots on token routes, rewrites, SEO tags, robots.txt, sitemap,
// assetlinks. Served by `wrangler dev` so public/_headers and public/_redirects are applied exactly as on Cloudflare.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rawRequest, TOKEN, requireBase, MOCK_API } from "./helpers/env.mjs";

requireBase();

const CSP =
  "default-src 'self'; script-src 'self' https://cloud.umami.is/script.js https://static.cloudflareinsights.com/beacon.min.js; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.beautica.app https://gateway.umami.is/api/send https://cloudflareinsights.com/cdn-cgi/rum; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
// Token routes load no analytics: their CSP is the base policy without the Umami / Cloudflare Web Analytics origins.
const TOKEN_CSP =
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
  { path: "/privacy", title: "Політика конфіденційності — Beautica", description: "Які дані збирає Beautica, навіщо, кому їх передає, скільки зберігає та як реалізувати права, зокрема для гостьового запису, відгуків і скарг.", canonical: "https://beautica.app/privacy", h1: "Політика конфіденційності" },
  { path: "/terms", title: "Умови користування — Beautica", description: "Правила користування Beautica: акаунти, записи, відгуки, фото, скарги й модерація, заборонені дії, відповідальність і право, що застосовується.", canonical: "https://beautica.app/terms", h1: "Умови користування" },
  { path: "/support", title: "Підтримка Beautica — як з нами зв'язатися", description: "Напишіть у підтримку Beautica: електронна пошта, форма в застосунку, що вказати у листі, а також контакти для питань про персональні дані.", canonical: "https://beautica.app/support", h1: "Підтримка" },
  { path: "/delete-account", title: "Видалення акаунта Beautica — як подати запит", description: "Як видалити акаунт Beautica в застосунку або без нього, які дані видаляються, що залишається і на який строк. Для гостей без акаунта теж.", canonical: "https://beautica.app/delete-account", h1: "Видалення акаунта" },
];

/** Token routes: the URL is the credential. `real` is the URL the backend e-mails; the shell is what the rewrite serves. */
const TOKEN_ROUTES = [
  { real: "/invite/accept?token=abc123", shell: "/l/invite", title: "Запрошення до Beautica", h1: "Вас запросили до Beautica" },
  { real: `/bookings/${TOKEN}`, shell: "/l/booking", title: "Ваш запис у Beautica", h1: "Ваш запис у Beautica" },
  { real: `/bookings/${TOKEN}/review`, shell: "/l/review", title: "Залиште відгук — Beautica", h1: "Залиште відгук" },
  { real: `/book/cancel/${TOKEN}`, shell: "/l/cancel", title: "Скасування запису — Beautica", h1: "Скасування запису" },
  { real: "/c/Ab3dEf7hJk9mNp2Q", shell: "/l/cancel", title: "Скасування запису — Beautica", h1: "Скасування запису" },
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
            const base = k === "content-security-policy" ? TOKEN_CSP : v;
            const expected = k === "content-security-policy" && r.shell === "/l/cancel" && target === res ? base.replace("https://api.beautica.app", MOCK_API) : base;
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

// Phase 032: the booking's own address is /c/{token}?n=1 (or the legacy /book/cancel/{uuid}?n=1). The Worker serves the confirmed shell (calendar block `#c-cal`)
// ONLY for the exact flag n=1; every other query is the plain cancel page. Both variants are token responses: same hardened headers, no analytics origins.
describe("phase 032: ?n=1 serves the confirmed cancel shell, anything else the plain one", () => {
  const PATHS = [`/c/Ab3dEf7hJk9mNp2Q`, `/book/cancel/${TOKEN}`];
  const apiNorm = (s) => s.replace(MOCK_API || "https://api.beautica.app", "https://api.beautica.app");
  const hasCalendarBlock = (body) => /id="c-cal"/.test(body);
  for (const base of PATHS) {
    describe(base.replace(TOKEN, ":id"), () => {
      test("?n=1: 200, confirmed shell (calendar block), token headers exactly once, CSP without umami / cloudflareinsights", async () => {
        const res = await rawRequest(`${base}?n=1`);
        assert.equal(res.status, 200);
        assert.equal(hasCalendarBlock(res.body), true, "the confirmed shell carries the calendar block");
        assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
        assert.deepEqual(res.all("cache-control"), ["no-store"]);
        assert.deepEqual(res.all("x-robots-tag"), ["noindex, nofollow"]);
        const csp = res.all("content-security-policy");
        assert.deepEqual(csp.map(apiNorm), [TOKEN_CSP]);
        assert.equal(/umami|cloudflareinsights/.test(csp[0]), false, "no analytics origin in a token response");
        assert.equal(meta(res.body, /<meta name="robots" content="([^"]*)"/), "noindex, nofollow");
        assert.equal(meta(res.body, /<meta name="referrer" content="([^"]*)"/), "no-referrer");
        assert.equal(/rel="canonical"/.test(res.body), false);
      });
      test("?n=1 differs from the plain shell only by the calendar variant (same runtime data-api origin)", async () => {
        const [yes, no] = [await rawRequest(`${base}?n=1`), await rawRequest(base)];
        const api = (b) => b.match(/id="cancel-root"[^>]*?\sdata-api="([^"]*)"/)?.[1];
        assert.ok(api(yes.body), "data-api is set");
        assert.equal(api(yes.body), api(no.body));
        assert.notEqual(yes.body, no.body);
      });
      for (const q of ["", "?n=0", "?n=2", "?n=", "?n=true", "?n=11", "?n=garbage", "?N=1", "?x=1", "?m=1&n=", "?n=%00"]) {
        test(`${q || "(no query)"}: plain cancel shell, no calendar block, same token headers`, async () => {
          const res = await rawRequest(`${base}${q}`);
          assert.equal(res.status, 200);
          assert.equal(hasCalendarBlock(res.body), false, "not the confirmed shell");
          assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
          assert.deepEqual(res.all("cache-control"), ["no-store"]);
          assert.deepEqual(res.all("x-robots-tag"), ["noindex, nofollow"]);
          assert.deepEqual(res.all("content-security-policy").map(apiNorm), [TOKEN_CSP]);
        });
      }
      test("?n=1 with an invalid token is still the 404 (no confirmed shell, token headers)", async () => {
        const res = await rawRequest(base.replace(/[^/]+$/, "bad!") + "?n=1");
        assert.equal(res.status, 404);
        assert.equal(hasCalendarBlock(res.body), false);
        assert.deepEqual(res.all("cache-control"), ["no-store"]);
        assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
      });
    });
  }
});

describe("malformed paths under token prefixes (the 404 must not report or leak the token)", () => {
  for (const path of [`/book/cancel/${TOKEN}/extra`, "/book/cancel/abc123/extra", "/invite/abc/def", `/bookings/${TOKEN}/nope`, "/l/nothing", "/c/Ab3dEf7hJk9mNp2Q/extra", "/c/a/b"]) {
    test(`${path}: 404, token CSP without analytics origins, no-referrer, no-store, noindex`, async () => {
      const res = await rawRequest(path);
      assert.equal(res.status, 404);
      assert.deepEqual(res.all("content-security-policy"), [TOKEN_CSP]);
      assert.equal(/umami|cloudflareinsights/.test(res.all("content-security-policy")[0]), false);
      assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
      assert.deepEqual(res.all("cache-control"), ["no-store"]);
      assert.match(res.all("x-robots-tag")[0], /noindex/);
    });
  }
});

describe("cancel link: token validated server-side", () => {
  for (const path of ["/c/bad!", "/c/short", "/book/cancel/not-a-uuid"]) {
    test(`${path}: 404 with token headers`, async () => {
      const res = await rawRequest(path);
      assert.equal(res.status, 404);
      assert.deepEqual(res.all("content-security-policy"), [TOKEN_CSP]);
      assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
      assert.deepEqual(res.all("cache-control"), ["no-store"]);
      assert.match(res.all("x-robots-tag")[0], /noindex/);
    });
  }
  for (const path of ["/c/Ab3dEf7hJk9mNp2Q", `/book/cancel/${TOKEN}`]) {
    test(`${path}: 200`, async () => {
      assert.equal((await rawRequest(path)).status, 200);
    });
  }
});

// Phase 007 QA (security LOW): a deeper path under a token prefix is not served by any route; the asset layer / catch-all answers it. Whoever answers,
// it must carry the token-route headers (a token may sit in the URL): no analytics origins in the CSP, no referrer, never cached, never indexed.
// Trailing-slash variants are separate cases: the asset layer treats `/a/b/` and `/a/b` differently.
describe("deeper token paths and trailing-slash variants (404 must still be a token response)", () => {
  const DEEP = ["/book/cancel/a/b/", "/book/cancel/a/b", "/book/cancel/a/", "/invite/x/y/", "/invite/x/y", "/bookings/x/y/", "/bookings/x/y", "/l/x/y/", "/l/x/y", `/book/cancel/${TOKEN}/`, `/book/cancel/${TOKEN}/extra/`, "/c/a/b/", "/c/Ab3dEf7hJk9mNp2Q/", "/c/Ab3dEf7hJk9mNp2Q/extra/"];
  for (const path of DEEP) {
    test(`${path}: 404 with the token CSP (no umami / cloudflareinsights), Referrer-Policy no-referrer once, no-store, noindex`, async () => {
      const res = await rawRequest(path);
      // One segment + trailing slash is the documented 307 to the slash-less token URL (tests/token-route-trailing-slash.test.mjs); the redirect is a token response too.
      const redirect = path === "/book/cancel/a/" || path === `/book/cancel/${TOKEN}/` || path === "/c/Ab3dEf7hJk9mNp2Q/";
      assert.equal(res.status, redirect ? 307 : 404, `status ${res.status}`);
      const csp = res.all("content-security-policy");
      assert.equal(csp.length, 1, "exactly one CSP");
      assert.equal(/umami|cloudflareinsights/.test(csp[0]), false, csp[0]);
      assert.ok(csp[0] === TOKEN_CSP || csp[0] === TOKEN_CSP.replace("https://api.beautica.app", MOCK_API), csp[0]);
      assert.deepEqual(res.all("referrer-policy"), ["no-referrer"]);
      assert.deepEqual(res.all("cache-control"), ["no-store"]);
      assert.deepEqual(res.all("x-robots-tag"), ["noindex, nofollow"]);
      assert.deepEqual(res.all("x-content-type-options"), ["nosniff"]);
    });
  }
  test("the 404 body of a token prefix does not echo the path and carries no analytics marker", async () => {
    const res = await rawRequest("/bookings/secret-looking-value/zzz/");
    assert.equal(res.status, 404);
    assert.equal(res.body.includes("secret-looking-value"), false);
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
  test("/.well-known/assetlinks.json is 200 JSON (an array), directly, cacheable for 5 minutes", async () => {
    const res = await rawRequest("/.well-known/assetlinks.json");
    assert.equal(res.status, 200);
    assert.equal(res.headers.location, undefined);
    assert.match(res.headers["content-type"], /^application\/json/);
    assert.deepEqual(res.all("cache-control"), ["public, max-age=300"]);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  test("/.well-known/assetlinks.json holds one android_app handle_all_urls statement with both signing fingerprints", async () => {
    const res = await rawRequest("/.well-known/assetlinks.json");
    assert.notEqual(res.body.trim(), "");
    const statements = JSON.parse(res.body);
    assert.equal(statements.length, 1);
    const [{ relation, target }] = statements;
    assert.deepEqual(relation, ["delegate_permission/common.handle_all_urls"]);
    assert.equal(target.namespace, "android_app");
    assert.equal(target.package_name, "com.beautica.app");
    const fingerprints = target.sha256_cert_fingerprints;
    assert.equal(fingerprints.length, 2);
    for (const fp of fingerprints) assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.ok(fingerprints.includes("EC:4E:53:47:89:90:97:76:D6:D6:E6:66:89:EA:DE:AE:2F:4B:EF:31:E7:BB:5F:11:95:13:95:D5:79:01:39:96"), "Play App Signing key");
    assert.ok(fingerprints.includes("84:C0:34:50:19:5C:16:DC:DC:C5:76:C1:94:D0:21:5F:DD:88:A5:AB:91:29:69:5A:EE:23:25:6F:95:2B:21:89"), "upload key");
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
    for (const l of ["User-agent: *", "Allow: /", "Disallow: /l/", "Disallow: /invite/", "Disallow: /bookings/", "Disallow: /book/cancel/", "Disallow: /c/", "Disallow: /api/", "Sitemap: https://beautica.app/sitemap-index.xml"]) {
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
