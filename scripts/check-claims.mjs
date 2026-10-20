#!/usr/bin/env node
// Verifies docs/claims.md: each row's source file exists and the line is in range, and each page anchor exists in dist/client.
// Sibling-repo sources (paths starting with ../) are skipped with a warning when the repo is absent (e.g. on CI).
// Exit 1 on any broken row. Needs a prior `npm run build` for anchor checks (missing dist = error).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledger = join(root, "docs", "claims.md");
if (!existsSync(ledger)) {
  console.error("check-claims: docs/claims.md missing");
  process.exit(1);
}

const rows = readFileSync(ledger, "utf8")
  .split("\n")
  .filter((l) => l.startsWith("|") && !/^\|\s*(claim|-)/.test(l))
  .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

let failed = 0;
let skipped = 0;
const fail = (n, msg) => {
  failed++;
  console.error(`FAIL row ${n}: ${msg}`);
};

rows.forEach((cells, i) => {
  const n = i + 1;
  if (cells.length < 4) return fail(n, "expected 4 columns");
  const [claim, anchor, source] = cells;

  const m = source.match(/^`(.+):(\d+)`$/);
  if (!m) fail(n, `source must be \`path:line\`: ${source}`);
  else {
    const file = resolve(root, m[1]);
    const sibling = m[1].startsWith("../");
    if (sibling && !existsSync(resolve(root, m[1].split("/").slice(0, 2).join("/")))) {
      skipped++;
      console.warn(`warn row ${n}: sibling repo absent, source not checked (${m[1]})`);
    } else if (!existsSync(file)) fail(n, `source file not found: ${m[1]}`);
    else {
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (Number(m[2]) < 1 || Number(m[2]) > lines) fail(n, `line ${m[2]} out of range (file has ${lines}): ${m[1]}`);
    }
  }

  const a = anchor.match(/^([a-z0-9/-]+)#([A-Za-z0-9_-]+)$/);
  if (!a) return fail(n, `page anchor must be route#id: ${anchor}`);
  const html = join(root, "dist", "client", `${a[1]}.html`);
  if (!existsSync(html)) return fail(n, `built page not found: dist/client/${a[1]}.html (run npm run build)`);
  if (!readFileSync(html, "utf8").includes(`id="${a[2]}"`)) fail(n, `anchor #${a[2]} not in ${a[1]}.html (${claim.slice(0, 50)})`);
});

console.log(`check-claims: ${rows.length} rows, ${failed} broken, ${skipped} sibling-source checks skipped`);
process.exit(failed ? 1 : 0);
