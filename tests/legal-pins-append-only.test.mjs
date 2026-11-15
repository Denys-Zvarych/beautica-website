// Legal pin fixtures are append-only: a published version's sha256 must never change and no entry may be removed, otherwise editing the
// text and rewriting the same-version hash would pass tests/booking-config.test.mjs. Compares the fixtures with the PR base branch.
//   PIN_BASE_REF  git ref holding the base fixtures (default origin/dev; CI: origin/<base_ref> after `git fetch`)
//   PIN_BASE_DIR  directory with the base fixtures instead of git (used to falsify this guard); ignored AND failing under REQUIRE_PIN_BASE=1
//   REQUIRE_PIN_BASE=1  a missing base is a failure (CI); otherwise the test skips with a message
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";

const FIXTURES = ["terms-versions.json", "privacy-policy-versions.json"];
const REF = process.env.PIN_BASE_REF || "origin/dev";
const REQUIRED = process.env.REQUIRE_PIN_BASE === "1";
const DIR_SET = Boolean(process.env.PIN_BASE_DIR);
// PIN_BASE_DIR is a test-only override: never honoured in CI (REQUIRE_PIN_BASE=1), where the real base ref must be compared.
const DIR = REQUIRED ? undefined : process.env.PIN_BASE_DIR;
// TODO(037): remove this allowance once phase 037 has merged to dev: terms-versions.json is new on the first PR only.
const MAY_BE_NEW_ON_BASE = new Set(["terms-versions.json"]);

/** Base fixture text, null when the file does not exist on the base (new fixture), undefined when the base itself is unavailable. */
const base = (f) => {
  if (DIR) return existsSync(join(DIR, f)) ? readFileSync(join(DIR, f), "utf8") : null;
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `${REF}^{commit}`], { cwd: ROOT }).status !== 0) return undefined;
  // ls-tree: exit 0 + empty output = path absent on base (new fixture); any non-zero exit is a real git error and must fail, never read as "new"
  const path = `tests/fixtures/${f}`;
  const ls = spawnSync("git", ["ls-tree", REF, "--", path], { cwd: ROOT, encoding: "utf8" });
  if (ls.status !== 0) throw new Error(`git ls-tree ${REF} -- ${path} failed (exit ${ls.status}): ${ls.stderr}`);
  if (ls.stdout.trim() === "") return null;
  const r = spawnSync("git", ["show", `${REF}:${path}`], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git show ${REF}:${path} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
};
/** Versions of a fixture, failing on a duplicate version (a Map would silently keep the last entry, hiding a forged same-version pin). */
const versionsOf = (text, label) => {
  const list = JSON.parse(text).versions;
  const seen = new Set();
  for (const p of list) {
    assert.ok(!seen.has(p.version), `${label}: duplicate version ${p.version}`);
    seen.add(p.version);
  }
  return list;
};
const available = DIR ? existsSync(DIR) : spawnSync("git", ["rev-parse", "--verify", "--quiet", `${REF}^{commit}`], { cwd: ROOT }).status === 0;

describe("legal pin fixtures are append-only against the base branch", () => {
  if (REQUIRED && DIR_SET) test("PIN_BASE_DIR is not allowed with REQUIRE_PIN_BASE=1", () => assert.fail("PIN_BASE_DIR is a test-only override; CI must compare against the real base ref (unset it)"));
  for (const f of FIXTURES) test(`${f}: exists in the working tree`, () => assert.ok(existsSync(join(ROOT, "tests/fixtures", f)), `${f} is missing from tests/fixtures`));
  if (!available && REQUIRED) test("base ref is available", () => assert.fail(`${REF} is not fetched: git fetch origin <base> before running (REQUIRE_PIN_BASE=1)`));
  for (const f of FIXTURES)
    test(`${f}: no published version removed or re-hashed`, { skip: available ? false : `base ref ${REF} not available locally: append-only check skipped (CI runs it)` }, () => {
      const old = base(f);
      if (old === null) {
        // a fixture missing on the base is new only where explicitly allowed; a renamed/deleted-on-base privacy pin must not skip the check
        assert.ok(MAY_BE_NEW_ON_BASE.has(f), `${f} does not exist on the base ${DIR ?? REF}: only ${[...MAY_BE_NEW_ON_BASE].join(", ")} may be new`);
        return;
      }
      const cur = versionsOf(readFileSync(join(ROOT, "tests/fixtures", f), "utf8"), `${f} (working tree)`);
      const now = new Map(cur.map((p) => [p.version, p.sha256]));
      for (const p of versionsOf(old, `${f} (base)`)) {
        assert.ok(now.has(p.version), `${f}: published version ${p.version} was removed`);
        assert.equal(now.get(p.version), p.sha256, `${f}: the pin of published version ${p.version} was changed: bump the version and pin the new text under the NEW version`);
      }
    });
});
