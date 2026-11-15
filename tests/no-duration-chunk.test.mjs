// The `?own` / `?ics` suffixes inline lib/booking/duration.ts into the /l/ cancel entries. If Vite ever stops honouring them the 155 B module becomes
// a shared chunk = one more request on the token pages, silently. Reads the built output (run npm run build first); no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";

const dist = join(ROOT, "dist/client");
const scriptsOf = (rel) => {
  const seen = new Set();
  const walk = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    for (const m of readFileSync(join(dist, p), "utf8").matchAll(/(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g)) walk(`/_astro/${m[1].slice(2)}`);
  };
  for (const m of readFileSync(join(dist, rel), "utf8").matchAll(/<script[^>]*\ssrc="(\/[^"]+\.js)"/g)) walk(m[1]);
  return [...seen];
};
for (const rel of ["/l/cancel.html", "/l/cancel-confirmed.html"])
  test(`${rel} loads no standalone duration chunk`, () => {
    assert.ok(existsSync(join(dist, rel)), `${rel} is not built: run npm run build first`);
    const files = scriptsOf(rel);
    assert.ok(files.length > 0);
    for (const f of files) assert.ok(!/duration/i.test(f), `${f} is a standalone duration chunk (the ?own/?ics inlining stopped working)`);
  });
