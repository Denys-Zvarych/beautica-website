// Phase 055 QA: safeguards that already hold but had no red-on-break test (Q2, Q3, Q4, Q6, Q7). Pure Node: no server, no build.
//   - the `site` job step list is byte-pinned like the heavy jobs (Q2: today's checks still run on every ready PR)
//   - the `changes` / `CI Gate` steps receive every env var their script reads (a dropped LABELS_JSON or DRAFT silently weakens Q1/Q3)
//   - classifier / gate edge rows not covered by ci-changes / ci-gate
//   - no spec or script outside the always-on `site` job reads an allow-listed path (Q6: a skipped heavy job must not hide a broken read)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { classify, isAllowListed } from "../scripts/ci/classify-changes.mjs";
import { evaluate } from "../scripts/ci/gate.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sha = (t) => createHash("sha256").update(t).digest("hex");
const ci = read(".github/workflows/ci.yml");
const pkg = JSON.parse(read("package.json"));
const jobBody = (id) => new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m").exec(ci)?.[1] ?? "";
const stepText = (id) => jobBody(id).split(/^    steps:\n/m)[1].split("\n").filter((l) => l.trim() && !/^\s*#/.test(l) && !/TEST_CONCURRENCY/.test(l)).join("\n");

describe("Q2: the `site` job step list is unchanged (pinned from the pre-phase-055 ci.yml)", () => {
  const SITE = "8f9613beda6169a0efc8684165f82699117e7e554ce53c00334d3fc2b4787caa";
  test("site steps byte-pinned (change on purpose: update the pin in the same PR and say why)", () => assert.equal(sha(stepText("site")), SITE, `current: ${sha(stepText("site"))}`));
  test("site still runs build, audit, lychee, html-validate, tokens, claims, responsive, static + contract suites", () => {
    const s = stepText("site");
    for (const needle of ["npm run build", "npm audit --omit=dev", "lycheeverse/lychee-action", "npx html-validate", "check-tokens.mjs", "npm run check:claims", "check-responsive.mjs", "npm run test:static", "npm run test:contract"]) assert.ok(s.includes(needle), needle);
  });
});

describe("Q1/Q3: the gate and classifier steps receive every env var their script reads", () => {
  const envOf = (id, stepName) => new RegExp(`- name: ${stepName}[\\s\\S]*?env:\\n((?:          .*\\n)+)`).exec(jobBody(id))?.[1] ?? "";
  test("changes: BASE_REF, BASE_SHA, HEAD_SHA, DRAFT, LABELS_JSON from the PR event", () => {
    const e = envOf("changes", "Classify");
    assert.match(e, /BASE_REF: \$\{\{ github\.base_ref \}\}/);
    assert.match(e, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    assert.match(e, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    assert.match(e, /DRAFT: \$\{\{ github\.event\.pull_request\.draft \}\}/);
    assert.match(e, /LABELS_JSON: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}/);
  });
  test("every env var classify-changes.mjs reads is set by the step", () => {
    const used = [...read("scripts/ci/classify-changes.mjs").matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]).filter((v) => v !== "GITHUB_OUTPUT");
    const set = envOf("changes", "Classify");
    for (const v of new Set(used)) assert.match(set, new RegExp(`^          ${v}:`, "m"), v);
  });
  test("ci-gate: PR_NUMBER, BASE_SHA, GH_TOKEN, NEEDS_JSON set; every non-default env var gate.mjs reads is covered", () => {
    const set = envOf("ci-gate", "Gate");
    for (const v of ["NEEDS_JSON", "PR_NUMBER", "BASE_SHA", "GH_TOKEN"]) assert.match(set, new RegExp(`^          ${v}:`, "m"), v);
    const used = [...read("scripts/ci/gate.mjs").matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
    for (const v of new Set(used)) assert.ok(set.includes(`${v}:`) || ["GITHUB_STEP_SUMMARY", "GITHUB_REPOSITORY"].includes(v), `${v} read by gate.mjs but not set`);
  });
  test("the classifier job never skips (no `if:`); `if: always()` on `ci-gate`", () => {
    assert.ok(!/^    if:/m.test(jobBody("changes").split(/^    steps:/m)[0]));
    assert.match(jobBody("ci-gate").split(/^    steps:/m)[0], /^    if: always\(\)$/m);
  });
  test("`changes` and `ci-gate` steps carry no `continue-on-error` (a swallowed failure would read green)", () => {
    for (const id of ["changes", "ci-gate"]) assert.ok(!/continue-on-error/.test(jobBody(id).replace(/#.*$/gm, "")), id);
  });
});

describe("Q3: gate job cost: shallow checkout + one base object; `changes` keeps full history", () => {
  const gate = jobBody("ci-gate").replace(/^\s*#.*$/gm, "");
  test("ci-gate: no fetch-depth: 0; fetches exactly the base sha at depth 1 BEFORE the Gate step reads it", () => {
    assert.ok(!/fetch-depth/.test(gate), "ci-gate must use the default shallow checkout");
    assert.match(gate, /run: git fetch --no-tags --depth=1 origin "\$BASE_SHA"/);
    assert.ok(gate.indexOf("git fetch --no-tags --depth=1") < gate.indexOf("git cat-file -e"), "fetch must precede the cat-file");
    assert.ok(!/continue-on-error|\|\| true/.test(gate), "a failed fetch must fail the job (never fall back to the PR's copy of gate.mjs)");
  });
  test("changes keeps fetch-depth: 0 (three-dot diff needs the merge base)", () => assert.match(jobBody("changes"), /fetch-depth: 0/));
});

describe("Q4/Q6: more classifier rows", () => {
  const dev = (files, x = {}) => classify({ baseRef: "dev", files, ...x });
  test("draft + empty diff -> heavy=true (empty-diff beats draft: never skip on a doubt)", () => assert.deepEqual(dev([], { draft: true }), { heavy: true, reason: "empty-diff" }));
  test("draft + docs-only diff -> draft (the gate, not the allow-list, decides)", () => assert.deepEqual(dev(["README.md"], { draft: true }), { heavy: false, reason: "draft" }));
  test("labels null / string / object -> ignored, never throws, falls through to the file rule", () => {
    for (const labels of [null, "full-ci", { 0: "full-ci" }]) assert.deepEqual(dev(["src/a.astro"], { labels }), { heavy: true, reason: "site-files" });
    for (const labels of [null, "full-ci"]) assert.deepEqual(dev(["README.md"], { labels }), { heavy: false, reason: "allowlist" });
  });
  test("a non-string entry among the files -> heavy=true", () => assert.equal(dev(["README.md", 7]).heavy, true));
  test("root-level non-.md and nested lookalikes stay heavy", () => {
    for (const p of ["README.txt", "package.json", ".gitignore/x", "LICENSE/x", ".claude", "docs.md/x", "Docs/x.md", "docs", ".github/workflows/x.yml", ".github/ISSUE_TEMPLATE", ".gitattributes", ".nvmrc", "wrangler.jsonc"]) assert.equal(isAllowListed(p), false, p);
  });
  test("the promotion row wins over every other input, including a classifier error", () => {
    assert.deepEqual(classify({ baseRef: "main", files: ["README.md"], draft: true, labels: [], error: new Error("x") }), { heavy: true, reason: "promotion" });
  });
});

describe("Q3: more gate rows", () => {
  const green = () => ({ changes: { result: "success", outputs: { heavy: "true", reason: "site-files" } }, site: { result: "success" }, e2e: { result: "success" }, e2e_booking: { result: "success" }, lighthouse: { result: "success" } });
  const never = () => { throw new Error("must not be asked"); };
  test("an unknown result string ('weird') on any job -> FAIL", () => {
    for (const j of ["changes", "site", "e2e", "e2e_booking", "lighthouse"]) {
      const n = green();
      n[j].result = "weird";
      assert.equal(evaluate({ needs: n, getLiveDraft: never }).ok, false, j);
    }
  });
  test("a heavy job missing from `needs` -> FAIL (a dropped job from the gate's needs list cannot read green)", () => {
    for (const j of ["e2e", "e2e_booking", "lighthouse", "site", "changes"]) {
      const n = green();
      delete n[j];
      assert.equal(evaluate({ needs: n, getLiveDraft: never }).ok, false, j);
    }
  });
  test("a green promotion row (reason promotion, all success) passes without a live-draft lookup", () => {
    const n = green();
    n.changes.outputs.reason = "promotion";
    assert.deepEqual(evaluate({ needs: n, getLiveDraft: never }), { ok: true, errors: [] });
  });
  test("heavy=false + reason allowlist but a heavy job FAILED (not skipped) -> FAIL", () => {
    const n = green();
    n.changes.outputs = { heavy: "false", reason: "allowlist" };
    n.e2e.result = "failure";
    assert.equal(evaluate({ needs: n, getLiveDraft: never }).ok, false);
  });
  test("a draft deferral never passes, whatever the live answer ('true', 'false', '', 'TRUE', garbage, throw)", () => {
    const n = green();
    n.changes.outputs = { heavy: "false", reason: "draft" };
    for (const e2e of ["skipped"]) n.e2e.result = n.e2e_booking.result = n.lighthouse.result = e2e;
    for (const v of ["true", "false", "", "TRUE", "null", "yes"]) assert.equal(evaluate({ needs: n, getLiveDraft: () => v }).ok, false, v);
    assert.equal(evaluate({ needs: n, getLiveDraft: never }).ok, false);
  });
});

describe("Q7: the full suite is not reduced", () => {
  test("both Lighthouse configs have numberOfRuns 3 and no `settings.onlyCategories` shrink vs the pinned bytes (sha pinned in ci-workflows)", () => {
    for (const f of ["lighthouserc.json", "scripts/lighthouserc-admin.json"]) assert.equal(JSON.parse(read(f)).ci.collect.numberOfRuns, 3, f);
  });
  test("test:static keeps every pre-phase spec and only adds the CI meta specs", () => {
    const list = pkg.scripts["test:static"].split(/\s+/).filter((x) => x.startsWith("tests/"));
    for (const f of ["static-build", "legal-bump", "privacy-telegram", "privacy-crash-reports", "legal-owner-delete", "delete-request-account-identifier", "app-package", "build-alerts"]) assert.ok(list.includes(`tests/${f}.test.mjs`), f);
    assert.equal(new Set(list).size, list.length, "duplicate spec in test:static");
  });
  test("this file runs in the site job (`npm run test:static`)", () => assert.ok(pkg.scripts["test:static"].includes("tests/ci-safeguards.test.mjs")));
});

describe("Q6: no spec/script outside the always-on site job reads an allow-listed path", () => {
  // Heavy-only specs = every spec NOT named in test:static / test:contract. check-*.mjs scripts used by `site` are excluded below by name.
  const siteSpecs = `${pkg.scripts["test:static"]} ${pkg.scripts["test:contract"]}`;
  const walk = (dir) => readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = join(dir, n);
    return statSync(join(ROOT, rel)).isDirectory() ? (n === "fixtures" ? [] : walk(rel)) : [rel];
  });
  const files = [...walk("tests"), ...walk("scripts")].filter((f) => /\.(mjs|sh)$/.test(f));
  const SITE_ONLY_SCRIPTS = new Set(["scripts/check-claims.mjs", "scripts/check-tokens.mjs", "scripts/check-responsive.mjs", "scripts/check-no-todo-owner.mjs", "scripts/list-not-live.mjs"]);
  const REF = /["'`]((?:docs\/[\w./-]*|\.claude\/[\w./-]*|\.github\/ISSUE_TEMPLATE\/[\w./-]*|README\.md|LICENSE|\.gitignore|[A-Z][A-Z_-]*\.md))["'`]|\bjoin\([^)]*["'`](?:docs|\.claude)["'`]/;
  const IO = /readFileSync|readdirSync|existsSync|statSync|createReadStream|\bread\(|readText|\bcat\b|\bjoin\(|resolve\(/;
  const offenders = (excludeClaims) => files
    .filter((f) => !SITE_ONLY_SCRIPTS.has(f) && !f.startsWith("scripts/ci/") && !/tests\/ci-[\w-]+\.test\.mjs$/.test(f))
    .filter((f) => !(f.startsWith("tests/") && siteSpecs.includes(f)))
    .flatMap((f) => read(f).split("\n").map((l, i) => [f, i + 1, l]).filter(([, , l]) => !/^\s*(\/\/|#)/.test(l) && IO.test(l) && REF.test(l) && !(excludeClaims && /claims\.md|["'`]docs["'`],\s*["'`]claims/.test(l))).map(([ff, n, l]) => `${ff}:${n}: ${l.trim().slice(0, 100)}`));
  test("found the spec files (a broken walk would pass vacuously)", () => assert.ok(files.length > 80 && files.includes("tests/booking-lib.test.mjs")));
  // docs/claims.md is the one docs/ file a heavy spec reads (booking-lib.test.mjs): the classifier must NOT allow-list it, so the sweep may skip it only then.
  test("docs/claims.md is not allow-listed (its heavy reader would be skipped otherwise)", () => assert.equal(isAllowListed("docs/claims.md"), false));
  test("no heavy-only spec/script reads an allow-listed path (docs/**, root *.md, LICENSE, .gitignore, .claude/**, issue templates); docs/claims.md is excluded from the sweep because it is NOT allow-listed", () => assert.deepEqual(offenders(!isAllowListed("docs/claims.md")), []));
  test("falsified: were docs/claims.md allow-listed, the sweep would flag tests/booking-lib.test.mjs", () => assert.ok(offenders(false).some((o) => o.startsWith("tests/booking-lib.test.mjs")), "booking-lib reader not seen"));
  test("the sweep sees a planted reader (falsified: the pattern is not vacuous)", () => {
    for (const l of ['readFileSync(join(ROOT, "docs", "x.md"))', 'read("docs/a.md")', 'readFileSync("README.md")', 'readFileSync(".gitignore")', 'readFileSync(join(ROOT, "LICENSE"))']) assert.ok(IO.test(l) && REF.test(l), l);
  });
});
