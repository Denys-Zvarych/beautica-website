#!/usr/bin/env node
// /admin quality gate (phase 039): starts the test-only harness (scripts/render-admin.mjs --serve), then check-responsive --base, check-axe and
// Lighthouse (scripts/lighthouserc-admin.json) on /admin. Needs a built dist/. `npm run check:admin`.
import { spawn, spawnSync } from "node:child_process";

const PORT = 4399;
const base = `http://127.0.0.1:${PORT}`;
const harness = spawn(process.execPath, ["scripts/render-admin.mjs", "--serve", String(PORT)], { stdio: "inherit", detached: true });
const stop = () => { try { process.kill(-harness.pid, "SIGTERM"); } catch { /* gone */ } };
process.on("exit", stop);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/admin`, { signal: AbortSignal.timeout(2000) })).status === 200) break; } catch { /* not up */ }
  if (i > 400) { console.error("check-admin: harness did not start"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
const steps = [
  ["check-responsive", [process.execPath, "scripts/check-responsive.mjs", "--base", base, "--routes", "/admin"]],
  ["check-axe", [process.execPath, "scripts/check-axe.mjs", `${base}/admin`]],
  ...(process.argv.includes("--no-lighthouse") ? [] : [["lighthouse", ["npx", "--no-install", "lhci", "autorun", "--config=scripts/lighthouserc-admin.json"]]]),
];
let failed = 0;
for (const [name, [cmd, ...args]] of steps) {
  console.log(`\n== ${name}`);
  if (spawnSync(cmd, args, { stdio: "inherit" }).status !== 0) { failed++; console.error(`check-admin: ${name} FAILED`); }
}
process.exit(failed ? 1 : 0);
