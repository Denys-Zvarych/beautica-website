#!/usr/bin/env node
// Cold-cache CLS probe: serves dist/client, delays font responses (so the fallback -> webfont swap really happens
// after first paint) and sums layout-shift entries. Two profiles:
//   stress     - fonts delayed by --delay ms, 320/360 px, budget 0.02 (the swap must stay shift-free even when late);
//   lighthouse - Lighthouse-mobile-like (412x823, fonts undelayed), budget 0.005: catches a lost font preload, which makes the
//                webfont arrive after first paint and reflows wrapped text (CLS 0.06 on / when the Nunito preload was dropped).
// No fixed sleeps: a run ends when the load event, fonts, finite animations and a 300 ms layout-shift quiet window are done.
// The lighthouse profile runs 4 pages in parallel; stress runs one at a time (see PROFILES). Full matrix ~2 min, CI subset ~30 s.
//
// Usage: node scripts/measure-cls.mjs [--runs 2] [--delay 400] [--routes /,/privacy] [--profiles stress,lighthouse] [--concurrency N]
//   CI uses a reduced set:  --runs 1 --routes /,/privacy,/delete-account,/l/cancel
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const RUNS = Number(arg("--runs", 2));
const DELAY = Number(arg("--delay", 400));
const ROUTES = arg("--routes", "/,/404,/privacy,/terms,/support,/delete-account,/l/invite,/l/cancel").split(",");
const WANTED = arg("--profiles", "stress,lighthouse").split(",");
const PROFILES = [
  // stress runs one page at a time: with parallel pages a slow first paint lets the (delayed) font win the race and the swap shift is
  // never observed (/terms @360: 0.0174 alone, 0.0000 with 4 in parallel). The undelayed lighthouse profile is timing-independent.
  { name: "stress", widths: [[320, 700], [360, 700]], delay: DELAY, limit: 0.02, concurrency: 1 },
  { name: "lighthouse", widths: [[412, 823]], delay: 0, limit: 0.005, concurrency: 4 },
].filter((p) => WANTED.includes(p.name));
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
const executablePath = process.env.CHROMIUM_PATH ?? ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });

/** One cold page load, returns its CLS. */
async function measure(route, width, height, motion) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__cls = 0;
      window.__lastShift = performance.now();
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__lastShift = performance.now(); if (!e.hadRecentInput) window.__cls += e.value; } }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(base + route, { waitUntil: "load" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
      while (performance.now() - window.__lastShift < 300) await new Promise((r) => setTimeout(r, 50)); // quiet window, not a fixed wait
    });
    return await page.evaluate(() => window.__cls);
  } finally {
    await ctx.close();
  }
}

let worst = 0;
let failed = false;
for (const prof of PROFILES) {
  currentDelay = prof.delay;
  const jobs = [];
  for (const route of ROUTES) for (const [width, height] of prof.widths) for (const motion of ["no-preference", "reduce"]) jobs.push({ route, width, height, motion, vals: [] });
  const queue = jobs.flatMap((j) => Array.from({ length: RUNS }, () => j));
  await Promise.all(Array.from({ length: Number(arg("--concurrency", prof.concurrency)) }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) j.vals.push(await measure(j.route, j.width, j.height, j.motion));
  }));
  for (const j of jobs) {
    const max = Math.max(...j.vals);
    if (max > prof.limit) failed = true;
    worst = Math.max(worst, max);
    console.log(`[${prof.name}] ${j.route} @${j.width} ${j.motion}: ${j.vals.map((v) => v.toFixed(4)).join(" ")} (max ${max.toFixed(4)}${max > prof.limit ? ` > ${prof.limit} FAIL` : ""})`);
  }
}
await browser.close();
server.close();
console.log(`worst CLS ${worst.toFixed(4)} ${failed ? "FAIL (stress > 0.02 or lighthouse > 0.005)" : "OK"}`);
process.exit(failed ? 1 : 0);
