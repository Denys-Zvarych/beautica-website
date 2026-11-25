#!/usr/bin/env node
// axe-core on one or more URLs with Playwright (the `@axe-core/cli` needs a chromedriver that does not run here).
//   node scripts/check-axe.mjs http://127.0.0.1:4399/admin [more urls ...] [--widths 360,768,1280]
// Fails (exit 1) on any violation (WCAG 2.x A/AA + best-practice). Browser: CHROMIUM_PATH or a Chromium in the usual places.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const argv = process.argv.slice(2);
const wi = argv.indexOf("--widths");
const widths = (wi >= 0 ? argv.splice(wi, 2)[1] : "360,768,1280").split(",").map(Number);
const urls = argv;
if (!urls.length) { console.error("usage: check-axe.mjs <url> [url...] [--widths 360,768,1280]"); process.exit(2); }

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const executablePath = process.env.CHROMIUM_PATH ?? ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome", "/snap/bin/chromium"].find(existsSync);
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
let bad = 0;
for (const url of urls) for (const width of widths) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(axeSource);
  const { violations } = await page.evaluate(() => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
  for (const v of violations) { bad++; console.error(`${url} @${width}: ${v.id} (${v.impact}) ${v.help}\n    ${v.nodes.map((n) => n.target.join(" ")).join("\n    ")}`); }
  console.log(`${url} @${width}: ${violations.length} violations`);
  await page.close();
}
await browser.close();
if (bad) { console.error(`check-axe: FAIL (${bad})`); process.exit(1); }
console.log("check-axe: OK");
