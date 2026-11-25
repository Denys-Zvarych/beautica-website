#!/usr/bin/env node
// /admin quality gate (phases 039 + 040 + 041): starts the test-only harness (scripts/render-admin.mjs --serve <free port>), then check-responsive --base,
// check-axe and Lighthouse (budgets of scripts/lighthouserc-admin.json) on /admin, /admin/requests and /admin/catalog. A second harness with CATALOG_MOCK_ROWS=100 and
// CATALOG_MOCK_CATEGORIES=200 asserts page 1 of a 100-row queue (25 cards) and of a 200-category catalog (10 categories x 12 types) against the SAME budgets. `--group sample|large` runs one half (CI runs them as two steps). `--group sample|large` runs one half (two CI steps). Needs a built dist/. `npm run check:admin`.
// Every harness is killed on exit (its process group, which holds wrangler), also on SIGINT / SIGTERM / a thrown error.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); }); });
const harnesses = [];
const stopAll = () => { for (const h of harnesses) { try { process.kill(-h.pid, "SIGTERM"); } catch { /* gone */ } } };
process.on("exit", stopAll);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });

async function start(env) {
  const port = await freePort();
  const h = spawn(process.execPath, ["scripts/render-admin.mjs", "--serve", String(port)], { stdio: "inherit", detached: true, env: { ...process.env, ...env } });
  harnesses.push(h);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/admin`, { signal: AbortSignal.timeout(2000) })).status === 200) return base; } catch { /* not up */ }
    if (i > 400) { console.error("check-admin: harness did not start"); process.exit(1); }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const noLh = process.argv.includes("--no-lighthouse");
// `--group sample|large` runs one half (the CI steps: each fits its own timeout); no switch = both (local full run).
const gi = process.argv.indexOf("--group");
const group = gi < 0 ? "all" : process.argv[gi + 1];
if (!["all", "sample", "large"].includes(group)) { console.error("check-admin: --group must be sample or large"); process.exit(2); }
const lh = (urls) => ["npx", "--no-install", "lhci", "autorun", "--config=scripts/lighthouserc-admin.json", ...urls.map((u) => `--collect.url=${u}`)];
let failed = 0;
const run = (name, [cmd, ...args]) => {
  console.log(`\n== ${name}`);
  if (spawnSync(cmd, args, { stdio: "inherit" }).status !== 0) { failed++; console.error(`check-admin: ${name} FAILED`); }
};
if (!["all", "sample", "large"].includes(group)) { console.error("check-admin: --group must be sample or large"); process.exit(2); }

if (group !== "large") {
  const base = await start({});
  run("check-responsive", [process.execPath, "scripts/check-responsive.mjs", "--base", base, "--routes", "/admin,/admin/requests,/admin/catalog,/admin/catalog?open=NAILS"]);
  run("check-axe", [process.execPath, "scripts/check-axe.mjs", `${base}/admin`, `${base}/admin/requests`, `${base}/admin/catalog`, `${base}/admin/catalog?open=NAILS`]);
  if (!noLh) run("lighthouse (sample data)", lh([`${base}/admin`, `${base}/admin/requests`, `${base}/admin/catalog`]));
}
if (group !== "sample") {
  const big = await start({ CATALOG_MOCK_ROWS: "100", CATALOG_MOCK_CATEGORIES: "200" });
  run("check-responsive (100 rows / 200 categories, page 1 + last page, one category open)", [process.execPath, "scripts/check-responsive.mjs", "--base", big, "--routes", "/admin/requests,/admin/requests?p=4,/admin/catalog,/admin/catalog?p=20,/admin/catalog?open=GEN_0001"]);
  if (!noLh) run("lighthouse (100-row queue + 200-category catalog, page 1 + one category open)", lh([`${big}/admin/requests`, `${big}/admin/catalog`, `${big}/admin/catalog?open=GEN_0001`]));
}
process.exit(failed ? 1 : 0);
