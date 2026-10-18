#!/usr/bin/env node
// Cold-cache CLS probe: serves dist/client, delays font responses (so the fallback -> webfont swap really happens
// after first paint) and sums layout-shift entries. Usage: node scripts/measure-cls.mjs [--runs 3] [--delay 400]
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const RUNS = Number(arg("--runs", 3));
const DELAY = Number(arg("--delay", 400));
const DIST = resolve("dist/client");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  const p0 = new URL(req.url, "http://x").pathname;
  const p = p0 === "/" ? "/index" : p0;
  const hit = [p, p + ".html"].map((c) => join(DIST, c)).find((f) => f.startsWith(DIST) && existsSync(f) && /\.[a-z0-9]+$/.test(f));
  const file = hit ?? join(DIST, "404.html");
  const send = () => { res.writeHead(hit ? 200 : 404, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }); res.end(readFileSync(file)); };
  extname(file) === ".woff2" ? setTimeout(send, DELAY) : send();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROMIUM_PATH ?? ["/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
let worst = 0;
for (const route of arg("--routes", "/,/404").split(",")) for (const width of [320, 360]) for (const motion of ["no-preference", "reduce"]) {
  const vals = [];
  for (let i = 0; i < RUNS; i++) {
    const ctx = await browser.newContext({ viewport: { width, height: 700 }, reducedMotion: motion });
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
  worst = Math.max(worst, max);
  console.log(`${route} @${width} ${motion}: ${vals.map((v) => v.toFixed(4)).join(" ")} (max ${max.toFixed(4)})`);
}
await browser.close();
server.close();
console.log(`worst CLS ${worst.toFixed(4)} ${worst <= 0.02 ? "OK" : "FAIL (> 0.02)"}`);
process.exit(worst <= 0.02 ? 0 : 1);
