#!/usr/bin/env node
// Lists features the pages mention that are not live yet. Convention (two sources):
//   1. HTML comments `<!-- add when live: <feature> ... -->` anywhere under src/ (content, pages, i18n).
//   2. Rows of docs/claims.md whose 4th column (status) is `not-live`.
// Informational: always exits 0. Reviewed in the release checklist.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

let count = 0;
for (const file of walk(join(root, "src"))) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = line.match(/add when live:\s*(.+?)(?:-->|$)/);
    if (m) {
      count++;
      console.log(`${relative(root, file)}:${i + 1}  ${m[1].trim().slice(0, 140)}`);
    }
  });
}
const ledger = join(root, "docs", "claims.md");
if (existsSync(ledger)) {
  for (const l of readFileSync(ledger, "utf8").split("\n")) {
    const c = l.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length >= 4 && c[3] === "not-live") {
      count++;
      console.log(`docs/claims.md  ${c[1]}  ${c[0].slice(0, 120)}`);
    }
  }
}
console.log(`list-not-live: ${count} not-live item(s)`);
