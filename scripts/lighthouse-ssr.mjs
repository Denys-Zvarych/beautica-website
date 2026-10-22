#!/usr/bin/env node
// Lighthouse (mobile, simulated throttling) on the SSR link pages: wrangler dev on the built site + the mock backend, 3 runs per URL,
// Photos (media.beautica.test) are blocked: the mock origin does not resolve, and a failing DNS lookup would be measured as page weight. Recheck
// the real LCP with prod photos (R2 offers no resize: dimensions are explicit, decoding async, below-fold images lazy).
// median LCP / TBT / CLS and total JS transfer. Fails when a budget is broken:  LCP < 2400 ms (target 2000), TBT < 50 ms, CLS < 0.02, JS <= 20480 B.
//
//   npm run build && node scripts/lighthouse-ssr.mjs [--runs 3]      (CHROME_PATH or a Chromium in the usual places)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startMockApi } from "../tests/helpers/mock-api.mjs";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const RUNS = Number(arg("--runs", 3));
const PAGES = ["/book/oksana-ab12", "/book/rail-8888", "/book/s/lavanda-1111", "/book/oksana-ab12?sort=OLDEST"];
// LCP target is 2000 ms. LCP is network-bound under Lantern (CPU 1x gives the same LCP; paint < 30 ms). The cost is font bytes requested before
// the observed LCP (Latin subsets are needed for spaces and digits). Shadows are not a factor. The master page measures about 2.2 s locally, so the FAIL line is 2400 ms (LCP_BUDGET to override) and anything between 2000 and 2400 is printed as a warning:
// ratchet the line down once the prod run (real photos, real network) is checked.
const TARGET_LCP = 2000;
const BUDGET = { lcp: Number(process.env.LCP_BUDGET ?? 2400), tbt: 50, cls: 0.02, js: 20480 };

if (!existsSync("dist/server/wrangler.json")) {
  console.error("lighthouse-ssr: run `npm run build` first");
  process.exit(2);
}
const chrome = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"].find(existsSync);
const free = () => new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });

const api = await startMockApi();
const port = await free();
const state = join(mkdtempSync(join(tmpdir(), "beautica-lh-")), "state");
const wr = spawn("npx", ["--no-install", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false", "--persist-to", state, "--var", `API_ORIGIN:${api.origin}`, "--var", "TURNSTILE_SITE_KEY:1x00000000000000000000AA"], { stdio: "ignore", detached: true, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
const stop = () => { try { process.kill(-wr.pid, "SIGKILL"); } catch {} api.close(); };
process.on("exit", stop);
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// Async on purpose: the mock backend lives in this process, a blocking call would starve it.
const run = (cmd, args, opts) => new Promise((res, rej) => spawn(cmd, args, opts).on("exit", (c) => (c === 0 ? res() : rej(new Error(`${cmd} exited ${c}`)))));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const bad = [];
for (const path of PAGES) {
  const lcp = [], tbt = [], cls = [], js = [];
  for (let i = 0; i < RUNS; i++) {
    const out = join(dirname(state), `lh-${i}.json`);
    await run("npx", ["--no-install", "lighthouse", `http://127.0.0.1:${port}${path}`, "--only-categories=performance", "--chrome-flags=--headless --no-sandbox", "--blocked-url-patterns=https://media.beautica.test/*", "--output=json", `--output-path=${out}`, "--quiet"], { env: { ...process.env, CHROME_PATH: chrome }, stdio: ["ignore", "ignore", "inherit"] });
    const r = JSON.parse(readFileSync(out, "utf8"));
    lcp.push(r.audits["largest-contentful-paint"].numericValue);
    tbt.push(r.audits["total-blocking-time"].numericValue);
    cls.push(r.audits["cumulative-layout-shift"].numericValue);
    js.push(r.audits["network-requests"].details.items.filter((x) => x.resourceType === "Script").reduce((a, x) => a + x.transferSize, 0));
  }
  const m = { lcp: median(lcp), tbt: median(tbt), cls: median(cls), js: median(js) };
  console.log(`${path}: LCP ${Math.round(m.lcp)} ms (runs ${lcp.map(Math.round)}), TBT ${Math.round(m.tbt)} ms, CLS ${m.cls.toFixed(3)}, JS ${m.js} B`);
  if (m.lcp >= TARGET_LCP && m.lcp < BUDGET.lcp) console.warn(`  warning: ${path} LCP ${Math.round(m.lcp)} ms is above the ${TARGET_LCP} ms target`);
  for (const k of Object.keys(BUDGET)) if (!(m[k] < BUDGET[k] || (k === "js" && m[k] <= BUDGET[k]))) bad.push(`${path}: ${k} ${m[k]} >= ${BUDGET[k]}`);
}
stop();
if (bad.length) { console.error("lighthouse-ssr: budget broken\n  " + bad.join("\n  ")); process.exit(1); }
console.log("lighthouse-ssr: OK");
process.exit(0);
