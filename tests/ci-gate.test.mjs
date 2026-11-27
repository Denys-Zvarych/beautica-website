// Phase 055 TC-2 (meta): the `CI Gate` decision table (scripts/ci/gate.mjs). The gate is the only required check, so a skipped or failed
// piece of required work must never read green. Pure Node: no server, no build.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { evaluate } from "../scripts/ci/gate.mjs";
import { ROOT } from "./helpers/env.mjs";
import { join } from "node:path";

const needs = ({ heavy = "true", reason = "site-files", changes = "success", site = "success", e2e = "success", e2e_booking = "success", lighthouse = "success" } = {}) => ({
  changes: { result: changes, outputs: { heavy, reason } },
  site: { result: site, outputs: {} },
  e2e: { result: e2e, outputs: {} },
  e2e_booking: { result: e2e_booking, outputs: {} },
  lighthouse: { result: lighthouse, outputs: {} },
});
const calls = [];
const live = (v) => () => (calls.push(v), v);
const boom = () => { throw new Error("gh: HTTP 502"); };
const run = (n, getLiveDraft = live("false")) => evaluate({ needs: n, getLiveDraft });
const failsWith = (r, re) => (assert.equal(r.ok, false), assert.ok(r.errors.some((e) => re.test(e)), `${re} not in ${JSON.stringify(r.errors)}`));

describe("TC-2 gate table", () => {
  test("all four jobs green with heavy=true -> pass", () => assert.deepEqual(run(needs()), { ok: true, errors: [] }));
  test("heavy=true + e2e skipped -> FAIL (a broken `if:` must not pass silently)", () => failsWith(run(needs({ e2e: "skipped" })), /heavy=true but e2e is 'skipped'/));
  test("heavy=true + each heavy job skipped, one at a time -> FAIL", () => {
    for (const j of ["e2e", "e2e_booking", "lighthouse"]) failsWith(run(needs({ [j]: "skipped" })), new RegExp(`${j} is 'skipped'`));
  });
  test("heavy=false allowlist + all heavy skipped + site success -> pass", () => assert.equal(run(needs({ heavy: "false", reason: "allowlist", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" })).ok, true));
  test("heavy=false allowlist but site failed / skipped -> FAIL (site is always required)", () => {
    failsWith(run(needs({ heavy: "false", reason: "allowlist", site: "failure", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" })), /site/);
    failsWith(run(needs({ heavy: "false", reason: "allowlist", site: "skipped", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" })), /site must succeed/);
  });
  test("draft deferral -> FAIL `DEFERRED: draft` when the live PR is a draft", () => {
    const r = run(needs({ heavy: "false", reason: "draft", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" }), live("true"));
    assert.deepEqual(r, { ok: false, errors: ["DEFERRED: draft"] });
  });
  test("deferral + live .draft=false -> FAIL `STALE DEFERRED`", () => failsWith(run(needs({ heavy: "false", reason: "draft", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" }), live("false")), /^STALE DEFERRED/));
  test("deferral + empty live answer -> FAIL `STALE DEFERRED` (fail closed)", () => failsWith(run(needs({ heavy: "false", reason: "draft", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" }), live("")), /^STALE DEFERRED/));
  test("deferral + API error -> FAIL `STALE DEFERRED` (fail closed)", () => {
    const r = run(needs({ heavy: "false", reason: "draft", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" }), boom);
    failsWith(r, /^STALE DEFERRED: the live draft check failed/);
    assert.equal(r.errors.some((e) => e === "DEFERRED: draft"), false);
  });
  test("empty / missing / unknown `heavy` output is treated as heavy=true", () => {
    for (const heavy of ["", undefined, "maybe", "FALSE"]) failsWith(run(needs({ heavy, e2e: "skipped" })), /heavy=true but e2e/);
    const n = needs({ e2e: "skipped" });
    delete n.changes.outputs;
    failsWith(run(n), /heavy=true but e2e/);
  });
  test("heavy=false with an unknown or empty reason -> FAIL", () => {
    for (const reason of ["", "site-files", "whatever", undefined]) failsWith(run(needs({ heavy: "false", reason, e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" })), /unknown reason/);
  });
  test("any failure or cancellation -> FAIL, for every job", () => {
    for (const j of ["changes", "site", "e2e", "e2e_booking", "lighthouse"])
      for (const r of ["failure", "cancelled"]) failsWith(run(needs({ [j]: r })), new RegExp(`${j}: ${r}`));
  });
  test("a failed `changes` job never passes even though the heavy jobs were skipped with it", () => failsWith(run(needs({ changes: "failure", heavy: "false", reason: "allowlist", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" })), /changes must succeed/));
  test("missing, null or garbage `needs` -> FAIL", () => {
    for (const n of [undefined, null, {}, "x", { changes: {}, site: {} }]) assert.equal(run(n).ok, false);
  });
  test("the live draft lookup is made for a draft deferral only", () => {
    calls.length = 0;
    run(needs());
    run(needs({ heavy: "false", reason: "allowlist", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" }));
    assert.deepEqual(calls, []);
  });
});

describe("TC-2 the CLI (what the `ci-gate` job runs)", () => {
  const script = join(ROOT, "scripts/ci/gate.mjs");
  const cli = (n, env = {}) => spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, NEEDS_JSON: typeof n === "string" ? n : JSON.stringify(n), ...env }, encoding: "utf8" });
  test("exit 0 on a green run, 1 on a failed one", () => {
    assert.equal(cli(needs()).status, 0);
    assert.equal(cli(needs({ lighthouse: "failure" })).status, 1);
  });
  test("exit 1 on missing or invalid NEEDS_JSON", () => {
    assert.equal(cli("{nope").status, 1);
    assert.equal(spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH }, encoding: "utf8" }).status, 1);
  });
  test("a draft deferral exits 1 even when `gh` is unavailable (fail closed, message STALE DEFERRED)", () => {
    const r = cli(needs({ heavy: "false", reason: "draft", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" }), { PR_NUMBER: "12", GITHUB_REPOSITORY: "o/r", PATH: "/nonexistent" });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /STALE DEFERRED/);
  });
  test("an invalid PR number fails closed too", () => {
    const r = cli(needs({ heavy: "false", reason: "draft", e2e: "skipped", e2e_booking: "skipped", lighthouse: "skipped" }), { PR_NUMBER: "12; rm", GITHUB_REPOSITORY: "o/r" });
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /STALE DEFERRED/);
  });
});

describe("no label mirror path (cycle 3: `labeled` is not a trigger, so the gate never reads earlier check runs)", () => {
  test("gate.mjs has no mirror / label-event code and no check-runs lookup", async () => {
    const src = (await import("node:fs")).readFileSync(join(ROOT, "scripts/ci/gate.mjs"), "utf8");
    assert.ok(!/mirrorLatest|isNoopLabelEvent|check-runs|EVENT_ACTION|LABEL_NAME/.test(src));
  });
  test("a stray label-event environment changes nothing: an all-green run passes, a failed one fails", () => {
    const script = join(ROOT, "scripts/ci/gate.mjs");
    const env = { PATH: process.env.PATH, EVENT_ACTION: "labeled", LABEL_NAME: "bug" };
    assert.equal(spawnSync(process.execPath, [script], { env: { ...env, NEEDS_JSON: JSON.stringify(needs()) }, encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(process.execPath, [script], { env: { ...env, NEEDS_JSON: JSON.stringify(needs({ e2e: "failure" })) }, encoding: "utf8" }).status, 1);
  });
});
