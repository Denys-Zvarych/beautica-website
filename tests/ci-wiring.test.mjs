// Phase 008/009 QA: the checks exist AND run on every PR. A spec nobody runs, a route Lighthouse never visits or a CI step with no
// time limit are regressions of the safety net itself. Reads .github/workflows/ci.yml, package.json, lighthouserc.json, scripts/.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const ci = read(".github/workflows/ci.yml");
const pkg = JSON.parse(read("package.json"));
const lhci = JSON.parse(read("lighthouserc.json"));
/** Steps of the workflow: { job, text } (a step starts with `      - ` inside a job). */
const steps = [];
for (const [, job, body] of ci.matchAll(/^  (\w+):\n([\s\S]*?)(?=^  \w+:\n|(?![\s\S]))/gm)) for (const s of body.split(/^      - /m).slice(1)) steps.push({ job, text: s });
const specs = readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.mjs"));
const excluded = (/TEST_EXCLUDE:\s*([\w.,-]+)/.exec(ci)?.[1] ?? "").split(",").filter(Boolean);

describe("every spec runs on pull requests", () => {
  test("the workflow triggers on PRs to dev and main", () => assert.match(ci, /pull_request:\s*\n\s*branches: \[dev, main\]/));
  for (const f of specs)
    test(`${f} is run by a CI step`, () => {
      const byDefault = !excluded.some((x) => f.includes(x)); // `npm test` runs everything not excluded
      const explicit = steps.some((s) => s.text.includes(`tests/${f}`)) || /test:static/.test(ci) && f === "static-build.test.mjs";
      assert.ok(byDefault || explicit, `${f} is excluded from npm test and no step runs it by name`);
    });
  test("`npm test` runs in the e2e job with a browser available", () => {
    const s = steps.find((x) => /run: npm test\b/.test(x.text));
    assert.equal(s?.job, "e2e");
    assert.match(ci, /CHROMIUM_PATH: \/usr\/bin\/google-chrome/);
  });
  test("every package.json test/check script used by CI exists", () => {
    for (const m of ci.matchAll(/npm run ([\w:-]+)/g)) if (m[1] !== "build") assert.ok(pkg.scripts[m[1]], `ci.yml runs npm run ${m[1]}, missing in package.json`);
  });
  test("the backend-contract and claims-pin specs run in the server-less site job against the checked-out backend, and FAIL when it is absent", () => {
    const s = steps.find((x) => /npm run test:contract/.test(x.text));
    assert.equal(s?.job, "site");
    assert.match(s.text, /REQUIRE_BACKEND: "1"/);
    assert.match(s.text, /BACKEND_DIR: beautica-backend/);
    assert.match(s.text, /steps\.backend\.outcome == 'success'/);
    assert.match(pkg.scripts["test:contract"], /contract-booking-api\.test\.mjs/);
    assert.match(pkg.scripts["test:contract"], /claims-pins\.test\.mjs/);
    assert.match(pkg.scripts["test:contract"], /booking-config\.test\.mjs/);
  });
  test("every step that runs specs, browsers or Lighthouse has timeout-minutes <= 5 (each step stays under 300 s)", () => {
    const heavy = steps.filter((s) => /run-tests\.mjs|npm test|lighthouse|lhci|measure-cls|test:contract|test:static/.test(s.text));
    assert.ok(heavy.length >= 8, `found ${heavy.length} heavy steps: the parser is broken`);
    for (const s of heavy) {
      const t = Number(/timeout-minutes:\s*(\d+)/.exec(s.text)?.[1]);
      assert.ok(t >= 1 && t <= 5, `step "${s.text.split("\n")[0]}" has timeout-minutes ${t || "none"}`);
    }
  });
});

describe("every route is under Lighthouse", () => {
  const routes = (dir, base = "") => readdirSync(join(ROOT, "src/pages", dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "api" ? [] : routes(join(dir, e.name), `${base}/${e.name}`)) : [`${base}/${e.name.replace(/\.(astro|ts)$/, "")}`]);
  const staticRoutes = routes("").filter((r) => !r.includes("[")).map((r) => (r === "/index" ? "/index" : r));
  const dynamicRoutes = routes("").filter((r) => r.includes("["));
  const lhciUrls = lhci.ci.collect.url.map((u) => new URL(u).pathname.replace(/\.html$/, ""));
  for (const r of staticRoutes)
    test(`static page ${r} is in lighthouserc.json (3 runs, median)`, () => {
      assert.ok(lhciUrls.includes(r), `${r} has no Lighthouse URL`);
      assert.equal(lhci.ci.collect.numberOfRuns, 3);
      assert.ok(lhci.ci.assert.assertMatrix.some((a) => new RegExp(a.matchingUrlPattern).test(`http://localhost${r}.html`) && a.aggregationMethod === "median"), `${r} matches no median assertion block`);
    });
  test("the SSR routes (no built HTML for LHCI) are covered by scripts/lighthouse-ssr.mjs: master, 12-photo rail, salon, sorted view; run in CI with 3 runs", () => {
    assert.deepEqual(dynamicRoutes.sort(), ["/book/[slug]", "/book/cancel/[token]", "/book/s/[slug]"]);
    const script = read("scripts/lighthouse-ssr.mjs");
    const pages = JSON.parse(/const PAGES = (\[.*?\]);/.exec(script)[1]);
    assert.ok(pages.some((p) => /^\/book\/[a-z0-9-]+$/.test(p)), "a master page");
    assert.ok(pages.includes("/book/rail-8888"), "the 12-photo rail");
    assert.ok(pages.some((p) => p.startsWith("/book/s/")), "a salon page");
    assert.ok(pages.some((p) => p.includes("?sort=")), "a sorted view");
    assert.match(ci, /node scripts\/lighthouse-ssr\.mjs --runs 3/);
    assert.ok(existsSync(join(ROOT, "tests/helpers/mock-api.mjs")));
  });
  test("the guest-cancel token route is measured through its static shell /l/cancel", () => assert.ok(lhciUrls.includes("/l/cancel")));
});
