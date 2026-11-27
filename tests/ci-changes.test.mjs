// Phase 055 TC-1 (meta): the classifier that decides whether the heavy CI jobs run (scripts/ci/classify-changes.mjs).
// Deny by default: only an all-allow-list diff (or a draft, which the gate then fails) skips them; every doubt, error and promotion PR runs them.
// Pure Node: needs no server and no build.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { ALLOW_EXACT, ALLOW_PREFIXES, classify, isAllowListed } from "../scripts/ci/classify-changes.mjs";

const dev = (files, extra = {}) => classify({ baseRef: "dev", files, ...extra });

describe("TC-1 classifier table", () => {
  test("root README.md only -> heavy=false (allowlist)", () => assert.deepEqual(dev(["README.md"]), { heavy: false, reason: "allowlist" }));
  test("docs / LICENSE / .gitignore / issue templates / .claude only -> heavy=false", () =>
    assert.equal(dev(["docs/x.md", "LICENSE", ".gitignore", ".github/ISSUE_TEMPLATE/bug.md", ".claude/commands/x.md", "CHANGELOG.md"]).heavy, false));
  test("docs/claims.md is read by tests/booking-lib.test.mjs (heavy e2e): alone, or among allow-listed files -> heavy=true", () => {
    assert.equal(isAllowListed("docs/claims.md"), false);
    assert.deepEqual(dev(["docs/claims.md"]), { heavy: true, reason: "site-files" });
    assert.equal(dev(["README.md", "docs/other.md", "docs/claims.md"]).heavy, true);
    assert.equal(isAllowListed("docs/claims.md.bak"), true, "only the exact file is carved out");
  });
  test("src/content/legal/uk/privacy.md -> heavy=true (content renders pages)", () => assert.equal(dev(["src/content/legal/uk/privacy.md"]).heavy, true));
  test("public/_headers -> true", () => assert.equal(dev(["public/_headers"]).heavy, true));
  test(".github/workflows/ci.yml -> true", () => assert.equal(dev([".github/workflows/ci.yml"]).heavy, true));
  test("one site file among allow-listed ones -> true", () => assert.equal(dev(["README.md", "docs/claims.md", "src/pages/index.astro"]).heavy, true));
  test("empty diff -> true (fail-safe)", () => assert.deepEqual(dev([]), { heavy: true, reason: "empty-diff" }));
  test("missing/invalid file list -> true", () => {
    assert.equal(dev(undefined).heavy, true);
    assert.equal(dev("README.md").heavy, true);
  });
  test("draft -> false (deferred; the gate fails it)", () => assert.deepEqual(dev(["src/pages/index.astro"], { draft: true }), { heavy: false, reason: "draft" }));
  test("draft + label full-ci -> true", () => assert.equal(dev(["src/pages/index.astro"], { draft: true, labels: ["full-ci"] }).heavy, true));
  test("label full-ci on a docs-only ready PR -> true", () => assert.equal(dev(["README.md"], { labels: ["x", "full-ci"] }).heavy, true));
  test("full-ci label on a draft docs-only PR -> heavy=true (reason full-ci); a draft without the label stays deferred", () => {
    assert.deepEqual(dev(["README.md"], { draft: true, labels: ["full-ci"] }), { heavy: true, reason: "full-ci" });
    assert.deepEqual(dev(["README.md"], { draft: true, labels: ["bug"] }), { heavy: false, reason: "draft" });
  });
  test("base main -> true even for a draft, an allow-list-only diff and an empty diff (promotion PR)", () => {
    assert.equal(classify({ baseRef: "main", files: ["README.md"], draft: true }).heavy, true);
    assert.equal(classify({ baseRef: "main", files: [], draft: true }).heavy, true);
    assert.equal(classify({ baseRef: "main", files: ["docs/x.md"], draft: false, labels: [] }).reason, "promotion");
  });
  test("a classifier error, an unknown or missing base -> true", () => {
    assert.equal(dev(["README.md"], { error: new Error("boom") }).heavy, true);
    assert.equal(dev(["README.md"], { error: "x", draft: true }).heavy, true);
    assert.equal(classify({ files: ["README.md"] }).heavy, true);
    assert.equal(classify({ baseRef: "staging", files: ["README.md"] }).heavy, true);
    assert.equal(classify().heavy, true);
  });
  test("draft is only the boolean true (a string or undefined is not a draft: more work, never less)", () => {
    assert.equal(dev(["src/a.astro"], { draft: "true" }).heavy, true);
    assert.equal(dev(["src/a.astro"], { draft: undefined }).heavy, true);
  });
});

describe("TC-1 allow-list (Q6) is pinned", () => {
  test("the allow-list is exactly the owner's list: falsified by moving src/content (or anything else) into it", () => {
    assert.deepEqual([...ALLOW_EXACT], ["LICENSE", ".gitignore"]);
    assert.deepEqual([...ALLOW_PREFIXES], ["docs/", ".github/ISSUE_TEMPLATE/", ".claude/"]);
    for (const p of ["src/content/legal/uk/privacy.md", "src/i18n/uk.json", "public/_headers", "scripts/ci/gate.mjs", "tests/a.test.mjs", "package.json", "package-lock.json", "astro.config.mjs", ".nvmrc", "lighthouserc.json", "lychee.toml", "wrangler.jsonc", ".github/workflows/ci.yml", ".github/CODEOWNERS", ".gitleaks.toml", ".htmlvalidate.json", "ops/x.md"])
      assert.equal(isAllowListed(p), false, p);
  });
  test("odd spellings never count as allow-listed", () => {
    for (const p of ["docs/../src/pages/index.astro", "docs//x.md", "./README.md", "/README.md", "docs", ".claude", ".github/ISSUE_TEMPLATE", "LICENSE.txt", "a/README.md", "src/README.md", ".md", "docs\\x.md", "README.md\n", "", undefined, null, 5])
      assert.equal(isAllowListed(p), false, String(p));
    for (const p of ["README.md", "docs/a/b.md", ".claude/x/y.json", ".github/ISSUE_TEMPLATE/config.yml"]) assert.equal(isAllowListed(p), true, p);
  });
});

describe("TC-1 the CLI (what the `changes` job runs), against a throwaway git repo", () => {
  const script = join(ROOT, "scripts/ci/classify-changes.mjs");
  const git = (cwd, ...a) => execFileSync("git", ["-c", "user.email=ci@test", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" }).trim();
  const repo = mkdtempSync(join(tmpdir(), "beautica-ci-classify-"));
  const outDir = mkdtempSync(join(tmpdir(), "beautica-ci-classify-out-")); // GITHUB_OUTPUT files live outside the repo: they must not enter the diff
  const put = (rel, text) => (mkdirSync(dirname(join(repo, rel)), { recursive: true }), writeFileSync(join(repo, rel), text));
  git(repo, "init", "-q");
  put("src/x.astro", "x");
  put("README.md", "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const run = (head, env = {}) => {
    const out = join(outDir, `out-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, "");
    execFileSync(process.execPath, [script], { cwd: repo, env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, BASE_REF: "dev", BASE_SHA: base, HEAD_SHA: head, DRAFT: "false", LABELS_JSON: "[]", ...env }, stdio: "pipe" });
    return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("=")));
  };
  const commit = (msg) => (git(repo, "add", "-A"), git(repo, "commit", "-qm", msg), git(repo, "rev-parse", "HEAD"));

  test("README.md change -> heavy=false reason=allowlist; the same diff with base main -> true", () => {
    put("README.md", "b");
    const head = commit("docs");
    assert.deepEqual(run(head), { heavy: "false", reason: "allowlist" });
    assert.deepEqual(run(head, { BASE_REF: "main" }), { heavy: "true", reason: "promotion" });
    assert.deepEqual(run(head, { DRAFT: "true" }), { heavy: "false", reason: "draft" });
    assert.equal(run(head, { DRAFT: "true", LABELS_JSON: '["full-ci"]' }).heavy, "true");
  });
  test("moving src/x.astro into docs/ is a site-file change (a rename lists both paths)", () => {
    mkdirSync(join(repo, "docs"));
    git(repo, "mv", "src/x.astro", "docs/x.astro");
    const head = commit("rename");
    assert.deepEqual(run(head), { heavy: "true", reason: "site-files" });
  });
  test("a bad sha, an unknown base object or garbage labels -> heavy=true classifier-error", () => {
    assert.deepEqual(run("nothex"), { heavy: "true", reason: "classifier-error" });
    assert.deepEqual(run("0".repeat(40)), { heavy: "true", reason: "classifier-error" });
    assert.deepEqual(run(git(repo, "rev-parse", "HEAD"), { LABELS_JSON: "{not json" }), { heavy: "true", reason: "classifier-error" });
    assert.deepEqual(run(git(repo, "rev-parse", "HEAD"), { BASE_SHA: "" }), { heavy: "true", reason: "classifier-error" });
  });
  test("an empty diff (head == base) -> heavy=true", () => assert.deepEqual(run(base), { heavy: "true", reason: "empty-diff" }));
  test("cleanup", () => (rmSync(repo, { recursive: true, force: true }), rmSync(outDir, { recursive: true, force: true })));
});
