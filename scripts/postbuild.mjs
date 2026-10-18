// The Cloudflare adapter (Workers-style output) writes dist/client/wrangler.json next to the site.
// Pages would serve it as a public file at /wrangler.json, and static deploys do not need it. Drop it.
// Revisit in phase 008 when the SSR Function output is wired (README D1/D2).
import { rmSync } from "node:fs";
rmSync("dist/client/wrangler.json", { force: true });
