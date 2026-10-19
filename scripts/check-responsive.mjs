#!/usr/bin/env node
// Responsive check at 360 / 768 / 1280 px (also 320 for overflow): no horizontal scroll, tap targets >= 48 px,
// targets >= 8 px apart. Serves dist/client with a tiny static server (unknown path -> 404.html, like Pages).
//
//   npm run build && node scripts/check-responsive.mjs [--routes /,/404] [--shots shots/]
//
// Browser: playwright-core + a Chromium. Set CHROMIUM_PATH, or install one with `npx playwright install chromium`.
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const ROUTES = arg("--routes", "/,/404").split(",");
const SHOTS = arg("--shots", "");
const WIDTHS = [320, 360, 768, 1280];
const DIST = resolve("dist/client");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon", ".xml": "application/xml", ".txt": "text/plain" };

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const candidates = [path, path + ".html", join(path, "index.html")];
  const hit = candidates.map((c) => join(DIST, c)).find((p) => p.startsWith(DIST) && existsSync(p) && /\.[a-z0-9]+$/.test(p));
  const file = hit ?? join(DIST, "404.html");
  res.writeHead(hit ? 200 : 404, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const executablePath = process.env.CHROMIUM_PATH ?? ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"].find(existsSync);
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const problems = [];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

for (const route of ROUTES) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(base + route, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500); // let entrance animations settle before measuring
    const r = await page.evaluate(() => {
      // WCAG 2.5.8 "inline" exception: links inside running legal prose (.prose p/li) whose paragraph has more text than the link are not tap-target buttons.
      const targets = [...document.querySelectorAll("a[href], button, input, select, textarea, summary, [role=button]")]
        .filter((el) => {
          const host = el.closest(".prose p, .prose li");
          if (getComputedStyle(el).pointerEvents === "none") return false; // inert (e.g. the always-open contents summary from 600 px)
          return !(host && el.matches(".prose a") && host.textContent.trim().length > el.textContent.trim().length);
        })
        .map((el) => ({ el, b: el.getBoundingClientRect() }))
        .filter((t) => t.b.width > 0 && t.b.height > 0)
        .map((t) => ({ row: !!t.el.closest(".site-footer .links, .toc"), tag: t.el.tagName + (t.el.className ? "." + String(t.el.className).split(" ")[0] : ""), x: t.b.x, y: t.b.y, w: t.b.width, h: t.b.height }));
      return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, targets };
    });
    const tag = `${route} @${width}`;
    if (r.scrollWidth > r.innerWidth) problems.push(`${tag}: horizontal scroll (${r.scrollWidth} > ${r.innerWidth})`);
    for (const t of r.targets) {
      if (t.w < 48 || t.h < 48) problems.push(`${tag}: target ${t.tag} is ${Math.round(t.w)}x${Math.round(t.h)} (< 48)`);
    }
    for (let i = 0; i < r.targets.length; i++) for (let j = i + 1; j < r.targets.length; j++) {
      const a = r.targets[i], b = r.targets[j];
      const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
      // Footer links and contents rows are full-size (>= 48 px) rows that tile edge to edge: WCAG 2.5.8 is met by the target size.
      if (a.row && b.row && a.h >= 48 && b.h >= 48 && Math.max(gapX, gapY) >= 0) continue;
      if (Math.max(gapX, gapY) < 8) problems.push(`${tag}: targets ${a.tag} and ${b.tag} are < 8 px apart`);
    }
    if (SHOTS && width !== 320) await page.screenshot({ path: join(SHOTS, `${route === "/" ? "index" : route.slice(1)}-${width}.png`), fullPage: true });
    console.log(`${tag}: scrollWidth ${r.scrollWidth} <= ${r.innerWidth}, ${r.targets.length} targets`);
    await page.close();
  }
}
await browser.close();
server.close();
if (problems.length) {
  console.error("check-responsive: FAIL\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log("check-responsive: OK");
