// Checks on the built output (dist/client), no server needed: CSP-safe markup, size budgets that Lighthouse cannot see
// (CSS is inlined, so its resource-summary is 0), and the two copies of the security headers staying in sync.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT } from "./helpers/env.mjs";
import { UMAMI_SCRIPT_SRC, UMAMI_HOST_URL, UMAMI_WEBSITE_ID, UMAMI_DOMAINS, CF_BEACON_SRC, CF_BEACON_TOKEN } from "../src/config/analytics.mjs";

const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");

const allHtml = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".html")) allHtml.push(p);
  }
})(DIST);
// /book-steps/* are HTML fragments the booking island fetches (phase 016), not pages: no head, no fonts, one JSON data block. Checked on their own below.
const FRAGMENT = "/book-steps/salon.html";
const htmlFiles = allHtml.filter((f) => !f.endsWith(FRAGMENT));
const name = (p) => "/" + relative(DIST, p);
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const KB = 1024;

test("the build produced the 10 expected pages", () => {
  assert.deepEqual(htmlFiles.map(name).sort(), ["/404.html", "/delete-account.html", "/index.html", "/l/booking.html", "/l/cancel-confirmed.html", "/l/cancel.html", "/l/invite.html", "/l/review.html", "/privacy.html", "/support.html", "/terms.html"]);
});

describe("the salon wizard fragment (phase 016)", () => {
  const frag = readFileSync(join(DIST, FRAGMENT), "utf8");
  test("exists, and its only script is the JSON data block (nothing executable, no handlers, no external sub-resources)", () => {
    const scripts = [...frag.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim());
    assert.deepEqual(scripts, ['type="application/json" id="book-i18n"']);
    assert.equal(/\s on[a-z]+\s*=\s*["']/i.test(frag.replace(/<style[\s\S]*?<\/style>/g, "")), false);
    assert.equal(/javascript:/i.test(frag), false);
    assert.equal(/\ssrc="(?:https?:)?\/\//.test(frag), false);
  });
  test("is not a page: no <html>, no <title>, no canonical", () => assert.equal(/<html|<title|rel="canonical"/.test(frag), false));
});

describe("CSP-safe markup (script-src 'self', no inline code)", () => {
  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf8");
    test(`${name(file)}: no inline script, no on*= handler, no javascript: URL, no external sub-resource`, () => {
      const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([, attrs, body]) => !/\bsrc=/.test(attrs) && !/type="application\/ld\+json"/.test(attrs) && body.trim());
      assert.deepEqual(inline.map((m) => m[2].slice(0, 60)), [], "inline <script> would be blocked by the CSP");
      assert.equal(/\s on[a-z]+\s*=\s*["']/i.test(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")), false, "inline event handler");
      assert.equal(/href\s*=\s*["']\s*javascript:/i.test(html), false);
      const external = [...html.matchAll(/<(?:script|img|iframe|source)\b[^>]*\ssrc="((?:https?:)?\/\/[^"]+)"/g)].map((m) => m[1]);
      const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((l) => /rel="(stylesheet|preload|icon|apple-touch-icon|modulepreload)"/.test(l)).filter((l) => /href="(https?:)?\/\//.test(l));
      assert.deepEqual([...external, ...links], [], "page loads something from another origin");
    });
  }
});

describe("analytics (phase 007): injected after load, never in the HTML", () => {
  const chunk = readdirSync(join(DIST, "_astro")).find((f) => f.startsWith("Analytics.astro_astro_type_script"));
  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf8");
    const token = name(file).startsWith("/l/");
    test(`${name(file)}: ${token ? "no analytics marker, loader or tag" : "marker + loader module, no render-path third-party tag"}`, () => {
      assert.equal(/umami|cloudflareinsights|data-website-id|data-cf-beacon/.test(html), false, "a third-party tag in the HTML would delay LCP");
      assert.equal(html.includes("beautica-analytics"), !token);
      assert.equal(html.includes(chunk), !token);
    });
  }
  test("the loader injects both tags with their attributes, after the load event / idle", () => {
    assert.ok(chunk, "Analytics loader chunk missing");
    const js = readFileSync(join(DIST, "_astro", chunk), "utf8") + readdirSync(join(DIST, "_astro")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(DIST, "_astro", f), "utf8")).join("\n");
    for (const v of [UMAMI_SCRIPT_SRC, UMAMI_HOST_URL, UMAMI_WEBSITE_ID, UMAMI_DOMAINS, CF_BEACON_SRC, CF_BEACON_TOKEN, "data-exclude-search", "data-exclude-hash", "data-cf-beacon", "requestIdleCallback", "load"]) assert.ok(js.includes(v), `${v} missing from the built loader`);
  });
  test("CSP allows exactly the analytics origins (script cloud.umami.is + beacon host; connect gateway + cloudflareinsights), token routes none", () => {
    const headers = readFileSync(join(DIST, "_headers"), "utf8");
    const star = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/*")).match(/Content-Security-Policy: (.+)/)[1];
    assert.ok(star.includes(`script-src 'self' ${UMAMI_SCRIPT_SRC} ${CF_BEACON_SRC};`), star);
    assert.ok(star.includes(`${UMAMI_HOST_URL}/api/send https://cloudflareinsights.com/cdn-cgi/rum;`), star);
    for (const p of ["/l/*", "/invite/*", "/bookings/*", "/book/cancel/*"]) {
      const csp = headers.split(/\n(?=\S)/).find((b) => b.startsWith(p + "\n")).match(/^\s+Content-Security-Policy: (.+)$/m)?.[1];
      assert.ok(csp && !/umami|cloudflareinsights/.test(csp), `${p}: token CSP carries analytics origins`);
    }
    const tsSrc = readFileSync(join(ROOT, "src/lib/securityHeaders.ts"), "utf8");
    assert.ok(tsSrc.includes(UMAMI_SCRIPT_SRC) && tsSrc.includes(`${UMAMI_HOST_URL}/api/send`) && tsSrc.includes(CF_BEACON_SRC));
  });
});

describe("size budgets (README § 4: JS <= 5 KB gz static, CSS <= 25 KB gz, fonts <= 4 files / 110 KB)", () => {
  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf8");
    test(`${name(file)}: inlined CSS <= 25 KB gz, JS <= 5 KB gz, critical fonts preloaded, <= 4 files / 110 KB`, () => {
      const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
      assert.ok(gz(Buffer.from(css)) <= 25 * KB, `inline CSS is ${gz(Buffer.from(css))} B gz`);
      const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith("/")); // same-origin only
      const jsGz = scripts.reduce((n, src) => n + gz(readFileSync(join(DIST, src))), 0);
      assert.ok(jsGz <= 5 * KB, `JS is ${jsGz} B gz (${scripts.join(", ")})`);
      const fonts = [...html.matchAll(/<link[^>]*rel="preload"[^>]*as="font"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(fonts.length <= 4, `${fonts.length} preloaded font files`);
      const fontBytes = fonts.reduce((n, f) => n + statSync(join(DIST, f)).size, 0);
      assert.ok(fontBytes <= 110 * KB, `preloaded fonts are ${fontBytes} B`);
      // A lost preload makes the webfont arrive after first paint and reflow wrapped text (CLS 0.06 on / when the Nunito preload was dropped).
      // Token pages also preload Comfortaa Latin: a lazily fetched font would send the token URL as Referer.
      // The legal pages preload the small "latin basic" files instead of the full Latin faces (fonts-legal.css); the other pages preload the full ones.
      const legal = ["/privacy.html", "/terms.html", "/support.html", "/delete-account.html"].includes(name(file));
      const required = ["nunito-cyrillic-wght", legal ? "nunito-latin-basic-wght" : "nunito-latin-wght", "comfortaa-cyrillic-wght", ...(name(file).startsWith("/l/") ? ["comfortaa-latin-wght"] : legal ? ["comfortaa-latin-basic-wght"] : [])];
      for (const r of required) assert.ok(fonts.some((f) => f.includes(r)), `${r} is no longer preloaded (${fonts.join(", ")})`);
    });
  }
});

describe("security headers: public/_headers (static assets) == src/lib/securityHeaders.ts (Worker)", () => {
  const ts = readFileSync(join(ROOT, "src/lib/securityHeaders.ts"), "utf8");
  const headers = readFileSync(join(DIST, "_headers"), "utf8");
  const star = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/*"));
  const fromHeaders = (h) => star.match(new RegExp(`^\\s+${h}: (.+)$`, "m"))?.[1];

  test("Content-Security-Policy is identical", () => {
    const body = ts.match(/export const CSP = \[([\s\S]*?)\]\.join/)[1];
    const csp = body.split("\n").map((l) => l.trim().match(/^"([^"]+)"/)?.[1]).filter(Boolean).join("; "); // first string per line: trailing comments may quote too
    assert.equal(fromHeaders("Content-Security-Policy"), csp);
  });

  for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) {
    test(`${h} is identical`, () => {
      const v = ts.match(new RegExp(`"${h}": "([^"]+)"`))?.[1];
      assert.ok(v, `${h} missing in securityHeaders.ts`);
      assert.equal(fromHeaders(h), v);
    });
  }

  test("every token prefix is covered by a no-referrer / no-store / noindex rule that drops the default Referrer-Policy", () => {
    for (const p of ["/l/*", "/invite/*", "/bookings/*", "/book/cancel/*"]) {
      const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith(p + "\n"));
      assert.ok(block, `no rule for ${p}`);
      assert.match(block, /^\s+! Referrer-Policy$/m, `${p} must detach the inherited Referrer-Policy`);
      assert.match(block, /^\s+Referrer-Policy: no-referrer$/m);
      assert.match(block, /^\s+Cache-Control: no-store$/m);
      assert.match(block, /^\s+X-Robots-Tag: noindex, nofollow$/m);
    }
  });

  test("the rewrites cover the four e-mail link shapes", () => {
    const r = readFileSync(join(DIST, "_redirects"), "utf8");
    for (const line of ["/invite/accept /l/invite 200", "/bookings/:id/review /l/review 200", "/bookings/:id /l/booking 200", "/book/cancel/:token /l/cancel 200"]) assert.ok(r.split("\n").includes(line), line);
  });
});

test("the legal pages load the small Latin basic subset, not the full Latin face (font budget headroom)", async () => {
  const { BASIC_RANGE } = await import("../scripts/subset-fonts.mjs");
  const css = readFileSync(join(ROOT, "src", "styles", "fonts-legal.css"), "utf8");
  assert.equal([...css.matchAll(/unicode-range: ([^;]+);/g)].map((m) => m[1]).join("|"), `${BASIC_RANGE}|${BASIC_RANGE}`, "fonts-legal.css range must equal BASIC_RANGE of scripts/subset-fonts.mjs");
  for (const p of ["privacy", "terms", "support", "delete-account"]) {
    const html = readFileSync(join(DIST, `${p}.html`), "utf8");
    const preloads = [...html.matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(preloads.some((h) => /nunito-latin-basic-/.test(h)) && preloads.some((h) => /comfortaa-latin-basic-/.test(h)), `/${p} preloads the basic subsets: ${preloads}`);
    assert.ok(!preloads.some((h) => /(nunito|comfortaa)-latin-wght-/.test(h)), `/${p} must not preload the full Latin faces`);
    // every Latin-range character of the visible text must be inside the basic range (otherwise the full face is requested on top)
    const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ");
    const ok = (c) => c <= 0xa0 || c === 0xa9 || c === 0xab || c === 0xb7 || c === 0xbb;
    const outside = [...new Set([...text].filter((ch) => { const c = ch.codePointAt(0); return c < 0x100 && !ok(c); }))];
    assert.deepEqual(outside, [], `/${p} renders Latin characters outside the basic subset: ${outside}`);
  }
});

describe("token shells carry <meta name=\"referrer\" content=\"no-referrer\"> (phase 024: no sub-resource may leak the token URL as Referer)", () => {
  for (const shell of ["/l/cancel.html", "/l/invite.html", "/l/booking.html", "/l/review.html"])
    test(`${shell}: exactly one no-referrer meta in the built HTML`, () => {
      const html = readFileSync(join(DIST, shell), "utf8");
      const metas = [...html.matchAll(/<meta\b[^>]*\bname="referrer"[^>]*>/g)].map((m) => m[0]);
      assert.equal(metas.length, 1, `${shell}: ${metas.length} referrer metas`);
      assert.match(metas[0], /\bcontent="no-referrer"/);
    });
});
