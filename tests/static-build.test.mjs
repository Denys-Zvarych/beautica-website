// Checks on the built output (dist/client), no server needed: CSP-safe markup, size budgets that Lighthouse cannot see
// (CSS is inlined, so its resource-summary is 0), and the two copies of the security headers staying in sync.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT } from "./helpers/env.mjs";

const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");

const htmlFiles = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".html")) htmlFiles.push(p);
  }
})(DIST);
const name = (p) => "/" + relative(DIST, p);
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const KB = 1024;

test("the build produced the 10 expected pages", () => {
  assert.deepEqual(htmlFiles.map(name).sort(), ["/404.html", "/delete-account.html", "/index.html", "/l/booking.html", "/l/cancel.html", "/l/invite.html", "/l/review.html", "/privacy.html", "/support.html", "/terms.html"]);
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

describe("size budgets (README § 4: JS <= 5 KB gz static, CSS <= 25 KB gz, fonts <= 4 files / 110 KB)", () => {
  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf8");
    test(`${name(file)}: inlined CSS <= 25 KB gz, JS <= 5 KB gz, critical fonts preloaded, <= 4 files / 110 KB`, () => {
      const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
      assert.ok(gz(Buffer.from(css)) <= 25 * KB, `inline CSS is ${gz(Buffer.from(css))} B gz`);
      const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      const jsGz = scripts.reduce((n, src) => n + gz(readFileSync(join(DIST, src))), 0);
      assert.ok(jsGz <= 5 * KB, `JS is ${jsGz} B gz (${scripts.join(", ")})`);
      const fonts = [...html.matchAll(/<link[^>]*rel="preload"[^>]*as="font"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(fonts.length <= 4, `${fonts.length} preloaded font files`);
      const fontBytes = fonts.reduce((n, f) => n + statSync(join(DIST, f)).size, 0);
      assert.ok(fontBytes <= 110 * KB, `preloaded fonts are ${fontBytes} B`);
      // A lost preload makes the webfont arrive after first paint and reflow wrapped text (CLS 0.06 on / when the Nunito preload was dropped).
      // Token pages also preload Comfortaa Latin: a lazily fetched font would send the token URL as Referer.
      const required = ["nunito-cyrillic-wght", "nunito-latin-wght", "comfortaa-cyrillic-wght", ...(name(file).startsWith("/l/") ? ["comfortaa-latin-wght"] : [])];
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
