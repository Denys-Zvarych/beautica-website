#!/usr/bin/env node
// Release gate: no `TODO(owner)` placeholder may reach a release. Fails when it appears in LEGAL_VARS (src/config/legal.mjs)
// or in any built file under dist/. CI runs it only for PRs whose base is `main`; dev PRs keep the placeholder.
//   npm run build && node scripts/check-no-todo-owner.mjs [--dist dist/client]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LEGAL_VARS } from "../src/config/legal.mjs";

const MARK = "TODO(owner)";
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const dist = resolve(arg("--dist", "dist"));
const problems = [];

for (const [k, v] of Object.entries(LEGAL_VARS)) if (String(v).includes(MARK)) problems.push(`LEGAL_VARS.${k} still holds ${MARK}`);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|xml|txt|json|js|mjs|css|md|webmanifest)$/.test(name) && readFileSync(p, "utf8").includes(MARK)) problems.push(`${p} contains ${MARK}`);
  }
}
try {
  walk(dist);
} catch (e) {
  console.error(`check-no-todo-owner: cannot read ${dist} (${e.code}); run npm run build first`);
  process.exit(2);
}

if (problems.length) {
  console.error("check-no-todo-owner: FAIL (release blocked)\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log(`check-no-todo-owner: OK — no ${MARK} in LEGAL_VARS or ${dist}`);
