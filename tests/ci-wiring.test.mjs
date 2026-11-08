// Phase 008/009 QA: the checks exist AND run on every PR. A spec nobody runs, a route Lighthouse never visits or a CI step with no
// time limit are regressions of the safety net itself. Reads .github/workflows/ci.yml, package.json, lighthouserc.json, scripts/.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
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
  test("the slow booking specs run in the e2e_booking job and the rest in e2e; both jobs have a job-level cap of 15-30 minutes (a single 12-minute job was cancelled)", () => {
    const where = (needle) => steps.find((x) => x.text.includes(needle))?.job;
    assert.equal(where("tests/booking-flow.test.mjs"), "e2e");
    assert.equal(where("tests/booking-privacy.test.mjs"), "e2e");
    assert.equal(where("tests/book-salon-wizard.test.mjs"), "e2e_booking");
    assert.equal(where("scripts/lighthouse-ssr.mjs"), "e2e_booking");
    assert.equal(steps.filter((x) => x.job === "e2e_booking" && x.text.includes("tests/book-axe.test.mjs")).length, 2, "axe at 360 and at 768,1280");
    for (const job of ["e2e", "e2e_booking"]) {
      const cap = (new RegExp(`^  ${job}:\\n[\\s\\S]*?^    timeout-minutes: (\\d+)`, "m").exec(ci) ?? [])[1];
      assert.ok(Number(cap) >= 15 && Number(cap) <= 30, `${job}: job timeout-minutes ${cap}`);
      // the steps of one job add up to less than its cap on a loaded runner (setup ~3 min + the steps' real durations, never all at their 5-minute caps)
      const n = steps.filter((x) => x.job === job && /timeout-minutes/.test(x.text)).length;
      assert.ok(n * 5 <= 80, `${job} has ${n} capped steps`);
    }
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
  test("every step that runs specs, browsers or Lighthouse has a timeout-minutes (<= 5; the npm test step <= 8; the lhci step <= 14)", () => {
    const heavy = steps.filter((s) => /run-tests\.mjs|npm test|lighthouse|lhci|measure-cls|test:contract|test:static/.test(s.text));
    assert.ok(heavy.length >= 8, `found ${heavy.length} heavy steps: the parser is broken`);
    for (const s of heavy) {
      const t = Number(/timeout-minutes:\s*(\d+)/.exec(s.text)?.[1]);
      // npm test (792 tests) takes ~305 s on a runner, just over 5 min: its step allows 8 (PR #30).
      const limit = /lhci autorun/.test(s.text) ? 14 : /^\s*run: npm test\s*$/m.test(s.text) ? 8 : 5; // lhci over 10 pages x 3 runs takes ~5.5 min on a runner; its job allows 15; lighthouse-ssr is split in two steps (3 + 2 pages) to stay within 5
      assert.ok(t >= 1 && t <= limit, `step "${s.text.split("\n")[0]}" has timeout-minutes ${t || "none"}`);
    }
  });
});

describe("every route is under Lighthouse", () => {
  const routes = (dir, base = "") => readdirSync(join(ROOT, "src/pages", dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "api" ? [] : routes(join(dir, e.name), `${base}/${e.name}`)) : [`${base}/${e.name.replace(/\.(astro|ts)$/, "")}`]);
  // The one deliberate exclusion: /book-steps/* are noindex HTML fragments the booking island fetches (phase 016), not pages; Lighthouse
  // measures the pages that load them. static-build.test.mjs checks the fragment itself (CSP-safe, no <html>/<title>).
  const staticRoutes = routes("").filter((r) => !r.includes("[") && !r.startsWith("/book-steps/")).map((r) => (r === "/index" ? "/index" : r));
  // Catch-all 404 routes ([...rest]) are not pages either: they only re-serve the static /404 page through the middleware so that malformed
  // token paths get the token headers (phase 007). Listed by name so a new catch-all cannot slip past Lighthouse unnoticed; /404 is measured.
  const CATCH_ALL_404 = ["/book/cancel/[...rest]", "/c/[...rest]"];
  const catchAll = routes("").filter((r) => r.includes("[..."));
  const dynamicRoutes = routes("").filter((r) => r.includes("[") && !r.includes("[..."));
  const lhciUrls = lhci.ci.collect.url.map((u) => new URL(u).pathname.replace(/\.html$/, ""));
  for (const r of staticRoutes)
    test(`static page ${r} is in lighthouserc.json (3 runs, median)`, () => {
      assert.ok(lhciUrls.includes(r), `${r} has no Lighthouse URL`);
      assert.equal(lhci.ci.collect.numberOfRuns, 3);
      assert.ok(lhci.ci.assert.assertMatrix.some((a) => new RegExp(a.matchingUrlPattern).test(`http://localhost${r}.html`) && a.aggregationMethod === "median"), `${r} matches no median assertion block`);
    });
  test("the SSR routes (no built HTML for LHCI) are covered by scripts/lighthouse-ssr.mjs: master, 12-photo rail, salon, sorted view; run in CI with 3 runs", () => {
    assert.deepEqual(dynamicRoutes.sort(), ["/book/[slug]", "/book/cancel/[token]", "/book/s/[slug]", "/c/[token]", "/r/[token]"]);
    const script = read("scripts/lighthouse-ssr.mjs");
    const pages = JSON.parse(/const PAGES = (\[.*?\]);/.exec(script)[1]);
    assert.ok(pages.some((p) => /^\/book\/[a-z0-9-]+$/.test(p)), "a master page");
    assert.ok(pages.includes("/book/rail-8888"), "the 12-photo rail");
    assert.ok(pages.some((p) => p.startsWith("/book/s/")), "a salon page");
    assert.ok(pages.some((p) => p.includes("?sort=")), "a sorted view");
    assert.ok(pages.some((p) => p.startsWith("/r/")), "the guest review form (phase 019)");
    // CI splits the pages over two steps (each <= 5 min) with LH_PAGES: together they must cover every page of the script, 3 runs each.
    const ciPages = [...ci.matchAll(/LH_PAGES='(\[.*?\])' node scripts\/lighthouse-ssr\.mjs --runs 3/g)].flatMap((m) => JSON.parse(m[1]));
    assert.deepEqual([...ciPages].sort(), [...pages].sort(), "the CI steps cover exactly the pages of lighthouse-ssr.mjs");
    assert.ok(existsSync(join(ROOT, "tests/helpers/mock-api.mjs")));
  });
  test("the only catch-all routes are the listed 404 re-servers (their page, /404, is under Lighthouse)", () => {
    assert.deepEqual(catchAll.sort(), CATCH_ALL_404);
    assert.ok(lhciUrls.includes("/404"));
  });
  test("the guest-cancel token route is measured through its static shell /l/cancel", () => assert.ok(lhciUrls.includes("/l/cancel")));
});

describe("phases 019 / 020 (guest review page, blocked-phone banner) are guarded on every PR", () => {
  test("book-blocked runs in the e2e job as its own step; review-page is excluded from it and runs by name in the e2e_booking job (its own step)", () => {
    for (const f of ["review-page.test.mjs", "book-blocked.test.mjs"]) assert.ok(specs.includes(f), `${f} exists`);
    assert.equal(steps.find((x) => x.text.includes("tests/book-blocked.test.mjs"))?.job, "e2e", "book-blocked has a step of its own in the e2e job");
    assert.equal(excluded.some((x) => "review-page.test.mjs".includes(x)), true, "review-page has a step of its own, so npm test skips it");
    assert.equal(steps.find((x) => /run: npm test\b/.test(x.text))?.job, "e2e");
    assert.equal(steps.find((x) => x.text.includes("tests/review-page.test.mjs"))?.job, "e2e_booking");
  });
  test("the /r/ route is also under the HTML validator and axe (they enumerate the route in their own sources)", () => {
    assert.match(read("tests/ssr-html-valid.test.mjs"), /\/r\//, "ssr-html-valid covers /r/");
    assert.match(read("tests/book-axe.test.mjs"), /\/r\//, "book-axe covers /r/");
  });
  test("lighthouse-ssr fails the build below Perf 90 (README § 8) on every SSR page, /r/ included", () => {
    const script = read("scripts/lighthouse-ssr.mjs");
    assert.match(script, /PERF_MIN = Number\(process\.env\.PERF_MIN \?\? 90\)/);
    assert.match(script, /if \(!\(m\.perf >= PERF_MIN\)\) bad\.push/);
    assert.match(script, /PAGES = \[[^\]]*"\/r\/rv/);
  });
});

describe("phase 018 (legal bump, legal fonts) is guarded on every PR", () => {
  test("legal-bump.test.mjs runs in the server-less site job (npm run test:static, after the build) and in npm test", () => {
    assert.match(pkg.scripts["test:static"], /tests\/legal-bump\.test\.mjs/);
    assert.equal(steps.find((x) => /npm run test:static/.test(x.text))?.job, "site");
    assert.equal(excluded.some((x) => "legal-bump.test.mjs".includes(x)), false, "legal-bump must not be in TEST_EXCLUDE");
  });
});

describe("phase 021 (privacy 1.4, Telegram section) is guarded on every PR", () => {
  test("privacy-telegram.test.mjs runs after the build in the server-less site job: test:static (dist checks) and test:contract (backend-pinned, REQUIRE_BACKEND)", () => {
    assert.match(pkg.scripts["test:static"], /tests\/privacy-telegram\.test\.mjs/);
    assert.match(pkg.scripts["test:contract"], /tests\/privacy-telegram\.test\.mjs/);
    assert.equal(excluded.some((x) => "privacy-telegram.test.mjs".includes(x)), false);
  });
});

describe("the shared mock backend", () => {
  test("no test clears its request log (POST /__mock/reset): files run concurrently against one mock, a reset deletes the other files' requests (use logMark() + mockLog(filter, mark))", () => {
    const offenders = readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.mjs") && f !== "ci-wiring.test.mjs" && /__mock\/reset/.test(readFileSync(join(ROOT, "tests", f), "utf8")));
    assert.deepEqual(offenders, []);
  });
});

describe("phase 030: no bearer token in Cloudflare logs", () => {
  test("wrangler.jsonc keeps Workers Logs on but invocation_logs off (they record the full request URL: /c/<token>, /api/ics?c=)", () => {
    const cfg = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
    assert.equal(cfg.observability.enabled, true);
    assert.strictEqual(cfg.observability.logs?.invocation_logs, false);
  });
});

describe("phase 032: the Lighthouse script budget of every built page is checked against the built output", () => {
  // The lhci static server gzips; a request costs ~400 B of headers on top (measured: /l/cancel-confirmed 8140 B gz + 8 requests = 11593 B transferred).
  // The estimate is gz + 400 B/request, never above the real transfer, so a page over its cap here is over it in lhci too.
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
  const cap = (url) => {
    const caps = lhci.ci.assert.assertMatrix.filter((a) => new RegExp(a.matchingUrlPattern).test(url)).map((a) => a.assertions["resource-summary:script:size"][1].maxNumericValue);
    return caps.length ? Math.min(...caps) : undefined;
  };
  for (const url of lhci.ci.collect.url) {
    const rel = new URL(url).pathname;
    test(`${rel}: estimated script transfer fits its lighthouserc cap`, () => {
      assert.ok(existsSync(join(dist, rel)), `${rel} is not built: run npm run build first`);
      const files = scriptsOf(rel);
      const est = files.reduce((n, f) => n + gzipSync(readFileSync(join(dist, f))).length + 400, 0);
      const c = cap(url);
      assert.ok(c !== undefined, `${rel} has no script:size cap`);
      assert.ok(est <= c, `${rel}: ${files.length} scripts, ~${est} B transferred > cap ${c} B (give the page its own assert entry with a measured _comment)`);
    });
  }
  test("/l/cancel-confirmed has its own assert entry (calendar block on top of the cancel page), not the shared 5120 block", () => {
    const own = lhci.ci.assert.assertMatrix.filter((a) => new RegExp(a.matchingUrlPattern).test("http://localhost/l/cancel-confirmed.html"));
    assert.equal(own.length, 1);
    assert.match(own[0].matchingUrlPattern, /cancel-confirmed/);
    assert.ok(own[0].assertions["resource-summary:script:size"][1].maxNumericValue > 5120);
    assert.match(own[0]._comment, /gz/);
  });
});
