#!/usr/bin/env node
// Cold-cache CLS probe: serves dist/client, delays font responses (so the fallback -> webfont swap really happens
// after first paint) and sums layout-shift entries. Two profiles:
//   stress     - fonts delayed by --delay ms, 320/360 px, budget 0.02 (the swap must stay shift-free even when late);
//   lighthouse - Lighthouse-mobile-like (412x823, fonts undelayed), budget 0.005: catches a lost font preload, which makes the
//                webfont arrive after first paint and reflows wrapped text (CLS 0.06 on / when the Nunito preload was dropped).
// Usage: node scripts/measure-cls.mjs [--runs 3] [--delay 400]
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const RUNS = Number(arg("--runs", 3));
const DELAY = Number(arg("--delay", 400));
const PROFILES = [
  { name: "stress", widths: [[320, 700], [360, 700]], delay: DELAY, limit: 0.02 },
  { name: "lighthouse", widths: [[412, 823]], delay: 0, limit: 0.005 },
];
let currentDelay = DELAY;
const DIST = resolve("dist/client");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  const p0 = new URL(req.url, "http://x").pathname;
  const p = p0 === "/" ? "/index" : p0;
  const hit = [p, p + ".html"].map((c) => join(DIST, c)).find((f) => f.startsWith(DIST) && existsSync(f) && /\.[a-z0-9]+$/.test(f));
  const file = hit ?? join(DIST, "404.html");
  const send = () => { res.writeHead(hit ? 200 : 404, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(readFileSync(file)); };
  extname(file) === ".woff2" && currentDelay > 0 ? setTimeout(send, currentDelay) : send();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROMIUM_PATH ?? ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
let worst = 0;
let failed = false;
for (const prof of PROFILES) for (const route of arg("--routes", "/,/404,/privacy,/terms,/support,/delete-account").split(",")) for (const [width, height] of prof.widths) for (const motion of ["no-preference", "reduce"]) {
  currentDelay = prof.delay;
  const vals = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(base + route, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    vals.push(await page.evaluate(() => window.__cls));
    await ctx.close();
  }
  const max = Math.max(...vals);
  if (max > prof.limit) failed = true;
  worst = Math.max(worst, max);
  console.log(`[${prof.name}] ${route} @${width} ${motion}: ${vals.map((v) => v.toFixed(4)).join(" ")} (max ${max.toFixed(4)})`);
}
await browser.close();
server.close();
console.log(`worst CLS ${worst.toFixed(4)} ${failed ? "FAIL (stress > 0.02 or lighthouse > 0.005)" : "OK"}`);
process.exit(failed ? 1 : 0);
