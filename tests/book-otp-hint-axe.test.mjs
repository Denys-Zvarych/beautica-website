// Phase 029: the phase-029 suites are never in CI's TEST_EXCLUDE (they must run on every PR through `npm test`).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("CI wiring", () => {
  test("the phase-029 suites are picked up by npm test (none in TEST_EXCLUDE)", () => {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const excluded = (/TEST_EXCLUDE:\s*([\w.,-]+)/.exec(ci)?.[1] ?? "").split(",").filter(Boolean);
    for (const f of ["otp-format.test.mjs", "book-otp-autofill.test.mjs", "book-webotp.test.mjs", "book-webotp-guards.test.mjs"]) {
      assert.equal(excluded.some((x) => f.includes(x)), false, `${f} must not be excluded`);
    }
  });
});
