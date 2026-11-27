// Phase 055 TC-7 / TC-9 / TC-10 (meta): the CI safety net itself must not erode. Reads .github/workflows/*.yml, scripts/, tests/ only; needs no server and no build.
//   TC-7  every job of every workflow runs on the fork-guarded runner expression (fork PRs never reach a self-hosted runner)
//   TC-9  Lighthouse budgets/runs and the step lists of the heavy jobs are byte-pinned
//   TC-10 every tests/*.test.mjs is executed by some job
//   + the gate wiring: heavy jobs need `changes`, `CI Gate` needs everything and always runs, the scripts come from the base branch
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { classify } from "../scripts/ci/classify-changes.mjs";
import { evaluate } from "../scripts/ci/gate.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sha = (t) => createHash("sha256").update(t).digest("hex");
const workflows = readdirSync(join(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/i.test(f)).sort();
const wf = Object.fromEntries(workflows.map((f) => [f, read(`.github/workflows/${f}`)]));
const ci = wf["ci.yml"];
const pkg = JSON.parse(read("package.json"));

/** THE runner expression (byte for byte; owner rule 2026-11-27, M566/B567/W055). */
const RUNS_ON = "runs-on: ${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && vars.CI_RUNNER_LINUX || 'ubuntu-latest' }}";
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l));

/** Offences of one workflow text: a job without the exact runs-on line, or a runner label spelled anywhere else. */
function runsOnOffences(text) {
  const lines = code(text);
  const out = [];
  let inJobs = false;
  let job = null;
  const jobs = [];
  for (const l of lines) {
    if (/^jobs:\s*$/.test(l)) { inJobs = true; continue; }
    if (/^\S/.test(l)) inJobs = false;
    if (!inJobs) continue;
    const m = /^  ([\w-]+):\s*$/.exec(l);
    if (m) { job = { id: m[1], runsOn: [] }; jobs.push(job); continue; }
    if (job && /^    runs-on\s*:/.test(l)) job.runsOn.push(l.trimEnd());
  }
  if (!jobs.length) out.push("no jobs found");
  for (const j of jobs) {
    if (j.runsOn.length !== 1) out.push(`${j.id}: ${j.runsOn.length} runs-on lines`);
    else if (j.runsOn[0] !== `    ${RUNS_ON}`) out.push(`${j.id}: runs-on is not the fork-guarded expression: ${j.runsOn[0].trim()}`);
  }
  for (const l of lines) if (l.trim() !== RUNS_ON && /ubuntu-|self-hosted|windows-|macos-|vars\.CI_RUNNER_|\brunner\.labels/i.test(l) && /runs-on|labels|CI_RUNNER/.test(l)) out.push(`runner label outside the expression: ${l.trim()}`);
  return out;
}

describe("TC-7 every job runs on the fork-guarded runner expression (Q9)", () => {
  test("found the three workflows", () => assert.deepEqual(workflows, ["ci.yml", "gitleaks.yml", "promotion-source.yml"]));
  // promotion-source.yml is the one pull_request_target workflow: it is literal hosted (tested below), not guarded.
  for (const f of workflows.filter((x) => x !== "promotion-source.yml")) test(`${f}: every job has exactly the fork-guarded runs-on, no hard-coded label`, () => assert.deepEqual(runsOnOffences(wf[f]), []));
  test("promotion-source.yml: literal `runs-on: ubuntu-latest` (a pull_request_target job must never see a repo variable or a self-hosted runner)", () => {
    assert.match(code(wf["promotion-source.yml"]).join("\n"), /^    runs-on: ubuntu-latest$/m);
  });
  test("ANY workflow with a pull_request_target trigger has no `vars.` / self-hosted in a runs-on line (falsified)", () => {
    const bad = (text) => {
      const c = code(text).join("\n");
      if (!/^\s+pull_request_target\s*:/m.test(c) && !/^on:.*pull_request_target/m.test(c)) return [];
      return c.split("\n").filter((l) => /^\s+runs-on\s*:/.test(l) && (/vars\./.test(l) || /self-hosted|\brunner\.labels|\[/.test(l)));
    };
    for (const f of workflows) assert.deepEqual(bad(wf[f]), [], f);
    const pr = wf["promotion-source.yml"];
    assert.ok(/pull_request_target/.test(pr), "the guard workflow really is pull_request_target");
    assert.ok(bad(pr.replace("runs-on: ubuntu-latest", RUNS_ON)).length > 0, "the fork-guarded expression is flagged");
    assert.ok(bad(pr.replace("runs-on: ubuntu-latest", "runs-on: ${{ vars.X }}")).length > 0, "bare vars flagged");
    assert.ok(bad(pr.replace("runs-on: ubuntu-latest", "runs-on: self-hosted")).length > 0, "self-hosted flagged");
    assert.ok(bad(wf["ci.yml"].replace("pull_request:", "pull_request_target:")).length > 0, "a ci.yml turned pull_request_target is flagged");
  });
  test("ci.yml carries the expression on all six jobs", () => assert.equal(ci.split(`    ${RUNS_ON}\n`).length - 1, 6));
  test("falsified: the checker flags an unguarded, hard-coded, self-hosted or bare-variable job", () => {
    const good = wf["ci.yml"];
    assert.deepEqual(runsOnOffences(good), []);
    const one = `    ${RUNS_ON}`;
    assert.ok(runsOnOffences(good.replace(one, "    runs-on: ubuntu-latest")).length > 0, "ubuntu-latest literal");
    assert.ok(runsOnOffences(good.replace(one, "    runs-on: self-hosted")).length > 0, "self-hosted literal");
    assert.ok(runsOnOffences(good.replace(one, "    runs-on: ${{ vars.CI_RUNNER_LINUX || 'ubuntu-latest' }}")).length > 0, "no fork guard");
    assert.ok(runsOnOffences(good.replace(one, "    runs-on: ${{ vars.CI_RUNNER_LINUX }}")).length > 0, "bare var");
    assert.ok(runsOnOffences(good.replace(one, one.replace("== github.repository", "!= github.repository"))).length > 0, "guard inverted");
    assert.ok(runsOnOffences(good.replace(one, "")).length > 0, "missing runs-on");
    assert.ok(runsOnOffences(good.replace(one, `${one}\n    runs-on: ubuntu-latest`)).length > 0, "second runs-on");
    assert.ok(runsOnOffences(good + "\n  extra:\n    steps: []\n").length > 0, "new job without runs-on");
    assert.ok(runsOnOffences(good + `\n  extra:\n    runs-on: [self-hosted, linux]\n`).length > 0, "label list");
  });
});

describe("workflow wiring: heavy jobs, the gate, triggers (Q1-Q4)", () => {
  const job = (text, id) => new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m").exec(text)?.[1];
  const head = (text, id) => (job(text, id) ?? "").split(/^    steps:/m)[0];
  const HEAVY = ["e2e", "e2e_booking", "lighthouse"];

  test("ci.yml: pull_request to dev/main with ready_for_review, NO labeled/unlabeled (full-ci applies on the next push or reopen; a re-run does not see it); no push, no paths filter (W10/W11)", () => {
    assert.match(ci, /^on:\n  pull_request:\n    branches: \[dev, main\]\n(    #.*\n)*    types: \[opened, synchronize, reopened, ready_for_review\]\n/m);
    assert.ok(!/labeled/.test(code(ci).join("\n")), "no label-event trigger or condition anywhere in ci.yml");
    assert.match(ci, /full-ci. label takes effect on the next push \(or close and reopen the PR\); a re-run reuses the old event\n    # payload and does not see a new label/);
    assert.match(read("README.md"), /takes effect on the next push \(or close and reopen the PR\); a re-run reuses the old event payload and does not see a new label/);
    assert.ok(!/^\s*push:/m.test(code(ci).join("\n")), "no push trigger");
    assert.ok(!/^\s+paths(-ignore)?:/m.test(code(ci).join("\n")), "a workflow-level paths filter would leave required checks pending");
  });
  test("concurrency: plain cancel-in-progress true (a new commit cancels the older run); the classifier reads labels + draft from the event", () => {
    assert.match(ci, /^concurrency:\n  group: ci-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: true\n/m);
    const c = job(ci, "changes");
    assert.match(c, /LABELS_JSON: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}/);
    assert.match(c, /DRAFT: \$\{\{ github\.event\.pull_request\.draft \}\}/);
  });
  test("full-ci on a draft or docs-only PR at push time -> heavy=true, and the gate then demands all three heavy jobs", () => {
    for (const draft of [true, false]) assert.deepEqual(classify({ baseRef: "dev", files: ["README.md"], draft, labels: ["full-ci"] }), { heavy: true, reason: "full-ci" });
    const needs = (heavyResult) => ({ changes: { result: "success", outputs: { heavy: "true", reason: "full-ci" } }, site: { result: "success" }, e2e: { result: heavyResult }, e2e_booking: { result: heavyResult }, lighthouse: { result: heavyResult } });
    const never = () => { throw new Error("no live draft lookup for a full-ci run"); };
    assert.equal(evaluate({ needs: needs("success"), getLiveDraft: never }).ok, true);
    assert.equal(evaluate({ needs: needs("skipped"), getLiveDraft: never }).ok, false, "a skipped heavy job under full-ci must fail the gate");
  });
  test("the heavy jobs need `changes` and run only on heavy == 'true' (no other condition: all logic lives in the classifier)", () => {
    for (const j of HEAVY) {
      const h = head(ci, j);
      assert.match(h, /^    needs: changes$/m, j);
      assert.match(h, /^    if: needs\.changes\.outputs\.heavy == 'true'$/m, j);
    }
  });
  test("`site` and `changes` have no needs and no `if` (always run); `changes` exposes heavy + reason", () => {
    for (const id of ["site", "changes"]) assert.ok(!/^    (needs|if):/m.test(head(ci, id)), id);
    const c = job(ci, "changes");
    assert.match(c, /heavy: \$\{\{ steps\.classify\.outputs\.heavy \}\}/);
    assert.match(c, /reason: \$\{\{ steps\.classify\.outputs\.reason \}\}/);
    assert.match(c, /fetch-depth: 0/);
  });
  test("`ci-gate` has only `if: always()`, no label env, and read-only permissions without `checks`", () => {
    const g = job(ci, "ci-gate");
    assert.deepEqual([...head(ci, "ci-gate").matchAll(/^    if: (.*)$/gm)].map((m) => m[1]), ["always()"]);
    assert.ok(!/EVENT_ACTION|LABEL_NAME|HEAD_SHA|checks:/.test(g));
  });
  test("`CI Gate`: display name, always(), needs exactly changes + site + the three heavy jobs, never skippable", () => {
    const h = head(ci, "ci-gate");
    assert.match(h, /^    name: CI Gate$/m);
    assert.match(h, /^    if: always\(\)$/m);
    assert.match(h, /^    needs: \[changes, site, e2e, e2e_booking, lighthouse\]$/m);
    assert.equal([...ci.matchAll(/^    name: CI Gate$/gm)].length, 1);
  });
  test("every job of ci.yml is accounted for: changes, site, 3 heavy, CI Gate", () => assert.deepEqual([...ci.split("\njobs:\n")[1].matchAll(/^  ([\w-]+):\n/gm)].map((m) => m[1]).sort(), ["changes", "ci-gate", "e2e", "e2e_booking", "lighthouse", "site"].sort()));
  test("the classifier and the gate run from the BASE sha (bootstrap to the head copy only when the base has none)", () => {
    for (const [id, file] of [["changes", "classify-changes"], ["ci-gate", "gate"]]) {
      const j = job(ci, id);
      assert.match(j, new RegExp(`git cat-file -e "\\$BASE_SHA:scripts/ci/${file}\\.mjs"`), id);
      assert.match(j, new RegExp(`git show "\\$BASE_SHA:scripts/ci/${file}\\.mjs"`), id);
      assert.match(j, /::warning::base branch has no/, id);
    }
  });
  test("untrusted values reach the shell through env only (no ${{ }} inside run: bodies of the new jobs)", () => {
    for (const id of ["changes", "ci-gate"]) for (const m of job(ci, id).matchAll(/^        run: \|\n((?:          .*\n?)+)/gm)) assert.ok(!m[1].includes("${{"), `${id}: expression inside run`);
  });
  test("gate step env: needs, PR number and a read-only token; permissions stay read", () => {
    const g = job(ci, "ci-gate");
    assert.match(g, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
    assert.match(g, /permissions:\n      contents: read\n      pull-requests: read\n/);
    assert.ok(!/write/.test(g.replace(/#.*$/gm, "")));
  });
  test("W4 (deferred): e2e workers stay at today's 2 until 10 green runs prove 4; run-tests.mjs reads TEST_CONCURRENCY, default 2", () => {
    const step = /run: npm test\n\s+env:\n([\s\S]*?)\n\n/.exec(ci)?.[1] ?? "";
    assert.match(step.replace(/^\s*#.*$/gm, ""), /^\s+TEST_CONCURRENCY: "2"$/m);
    assert.match(read("scripts/run-tests.mjs"), /let concurrency = Number\(process\.env\.TEST_CONCURRENCY \?\? 2\);/);
    assert.equal([...ci.matchAll(/TEST_CONCURRENCY/g)].length - [...ci.matchAll(/# .*TEST_CONCURRENCY/g)].length, 1, "set once, on the e2e npm test step");
  });
  test("W5 (deferred): gitleaks KEEPS its push trigger on dev/main until the rulesets exist; PR, weekly schedule and manual dispatch stay", () => {
    const g = code(wf["gitleaks.yml"]).join("\n");
    assert.match(g, /^  push:\n    branches: \[main, dev\]/m);
    assert.match(g, /^  pull_request:\n    branches: \[main, dev\]/m);
    assert.match(g, /^  schedule:\n.*cron: '0 6 \* \* 1'/m);
    assert.match(g, /^  workflow_dispatch: \{\}/m);
    assert.match(g, /^    name: Scan for secrets$/m);
    assert.match(wf["gitleaks.yml"], /rulesets/i, "the note that the push trigger may go only after the rulesets exist stays");
  });
  test("the required check names exist: `CI Gate`, `Scan for secrets`, `Promotion source (<base>)`", () => {
    assert.match(wf["promotion-source.yml"], /^    name: Promotion source \(\$\{\{ github\.event\.pull_request\.base\.ref \}\}\)$/m);
    assert.match(wf["gitleaks.yml"], /^    name: Scan for secrets$/m);
  });
});

describe("TC-9 the quality budget of the full suite is unchanged (Q2/Q7)", () => {
  test("Lighthouse configs byte-identical (sha256) with 3 runs and the median", () => {
    assert.equal(sha(read("lighthouserc.json")), "4cad418610826c081464d65c265f39ebc950442bc5d84863ad15d23be1ddc160");
    assert.equal(sha(read("scripts/lighthouserc-admin.json")), "34c025bc1af58476a19f13988d308b87e8681a1b088850446584fd4034de7c62");
    for (const f of ["lighthouserc.json", "scripts/lighthouserc-admin.json"]) {
      const c = JSON.parse(read(f)).ci;
      assert.equal(c.collect.numberOfRuns, 3, f);
    }
  });
  test("lighthouse-ssr.mjs: RUNS default 3, PERF_MIN 90, BUDGET lcp 2400 / tbt 50 / cls 0.02 / js 20480", () => {
    const s = read("scripts/lighthouse-ssr.mjs");
    assert.match(s, /^const RUNS = Number\(arg\("--runs", 3\)\);$/m);
    assert.match(s, /^const PERF_MIN = Number\(process\.env\.PERF_MIN \?\? 90\);/m);
    assert.match(s, /^const BUDGET = \{ lcp: Number\(process\.env\.LCP_BUDGET \?\? 2400\), tbt: 50, cls: 0\.02, js: 20480 \};$/m);
  });
  test("the CI Lighthouse steps pass --runs 3 and the lhci step is unchanged", () => {
    assert.equal([...ci.matchAll(/node scripts\/lighthouse-ssr\.mjs --runs 3$/gm)].length, 2);
    assert.match(ci, /run: npx --no-install lhci autorun$/m);
    assert.match(ci, /node scripts\/check-admin\.mjs --group sample/);
    assert.match(ci, /node scripts\/check-admin\.mjs --group large/);
  });
  // The step list of each heavy job (comments, blanks and the W4 worker count stripped): editing, removing or reordering a step changes the hash.
  const stepText = (id) => {
    const body = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m").exec(ci)[1];
    return body.split(/^    steps:\n/m)[1].split("\n").filter((l) => l.trim() && !/^\s*#/.test(l) && !/TEST_CONCURRENCY/.test(l)).join("\n");
  };
  // Pinned from the pre-phase-055 ci.yml (identical hashes before and after the phase: no step was added, removed, reordered or edited).
  const PINNED = {
    e2e: "c87c757b7e50484ed7d41c62aa88b6c8120cc990db271efeb02987c698449bad",
    e2e_booking: "cd7748bf41ac1fbd04a353822f801cf1c57ec1447366b12be5f384895a137751",
    lighthouse: "cf2b4b827cd13fe7560f8493682c4aa5deaa112f0b8a660e4d60a366857f8039",
  };
  for (const id of Object.keys(PINNED))
    test(`${id}: step list pinned (change it on purpose: update the pin in the same PR and say why)`, () => assert.equal(sha(stepText(id)), PINNED[id], `current ${id} step hash: ${sha(stepText(id))}`));
  // Job-level knobs are outside the step hash: pin them too (a shortened timeout or a dropped CHROMIUM_PATH would silently weaken the heavy jobs).
  const jobHead = (id) => (new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, "m").exec(ci)?.[1] ?? "").split(/^    steps:/m)[0].split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const JOB_KNOBS = { e2e: { timeout: 20, chromium: true }, e2e_booking: { timeout: 25, chromium: true }, lighthouse: { timeout: 15, chromium: false } };
  const knobOffences = (head, id) => {
    const k = JOB_KNOBS[id];
    const out = [];
    if (!new RegExp(`^    timeout-minutes: ${k.timeout}$`, "m").test(head)) out.push(`${id}: timeout-minutes must be ${k.timeout}`);
    const env = /^    env:\n((?:      .*\n?)*)/m.exec(head)?.[1];
    if (k.chromium) { if (env?.trim() !== "CHROMIUM_PATH: /usr/bin/google-chrome") out.push(`${id}: job env must be exactly CHROMIUM_PATH: /usr/bin/google-chrome`); }
    else if (env !== undefined) out.push(`${id}: no job-level env expected`);
    return out;
  };
  for (const id of Object.keys(JOB_KNOBS)) test(`${id}: job timeout-minutes ${JOB_KNOBS[id].timeout} and env pinned`, () => assert.deepEqual(knobOffences(jobHead(id), id), []));
  test("falsified: a shorter timeout, a dropped or changed CHROMIUM_PATH, an extra env are flagged", () => {
    const h = jobHead("e2e");
    assert.ok(knobOffences(h.replace("timeout-minutes: 20", "timeout-minutes: 10"), "e2e").length > 0);
    assert.ok(knobOffences(h.replace("CHROMIUM_PATH: /usr/bin/google-chrome", "CHROMIUM_PATH: /usr/bin/chromium"), "e2e").length > 0);
    assert.ok(knobOffences(h.replace(/    env:\n.*\n/, ""), "e2e").length > 0);
    assert.ok(knobOffences(jobHead("lighthouse") + "    env:\n      X: 1\n", "lighthouse").length > 0);
  });
  test("falsified: removing or editing a step changes the pinned hash", () => {
    const t = stepText("e2e");
    assert.notEqual(sha(t.replace("node scripts/measure-cls.mjs --profiles stress", "node scripts/measure-cls.mjs --profiles x")), sha(t));
    assert.notEqual(sha(t.split("\n").slice(0, -3).join("\n")), sha(t));
  });
});

describe("TC-10 every tests/*.test.mjs runs in some job (Q7)", () => {
  const specs = readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.mjs"));
  // Real, uncommented lines only: a spec named in a comment is not run by any step.
  const ciCode = code(ci).join("\n");
  const excluded = (/TEST_EXCLUDE:\s*([\w.,-]+)/.exec(ciCode)?.[1] ?? "").split(",").filter(Boolean);
  const staticScripts = `${pkg.scripts["test:static"]} ${pkg.scripts["test:contract"]}`;
  /** Where a spec runs: `npm test` (every file not excluded), a named `run-tests.mjs` step, or a package.json script a CI step runs. */
  const runners = (f, { excl = excluded, ciText = ciCode, scripts = staticScripts } = {}) => {
    ciText = code(ciText).join("\n");
    const r = [];
    if (!excl.some((x) => f.includes(x))) r.push("npm test");
    if (ciText.includes(`node scripts/run-tests.mjs tests/${f}`)) r.push("named step");
    if (scripts.includes(`tests/${f}`)) r.push("npm run test:static|contract");
    return r;
  };
  test("found the spec files (a broken glob would pass vacuously)", () => assert.ok(specs.length >= 73, `only ${specs.length} specs`));
  for (const f of specs) test(`${f} is executed by a CI job`, () => assert.ok(runners(f).length >= 1, `${f}: excluded from npm test and no step names it`));
  test("every TEST_EXCLUDE entry has a named step (an excluded spec never silently vanishes)", () => {
    for (const x of excluded) {
      const hit = specs.filter((f) => f.includes(x));
      assert.ok(hit.length >= 1, `TEST_EXCLUDE ${x} matches no spec`);
      for (const f of hit) assert.ok(runners(f, { excl: [] }).length >= 2 && runners(f).length >= 1, `${f} is excluded and has no step`);
    }
  });
  test("the three CI-meta specs run in the site job's `npm run test:static`", () => {
    for (const f of ["ci-changes.test.mjs", "ci-gate.test.mjs", "ci-workflows.test.mjs"]) assert.ok(pkg.scripts["test:static"].includes(`tests/${f}`), f);
  });
  test("falsified: a spec named only in a comment (or only in a commented TEST_EXCLUDE) is not counted as run", () => {
    assert.deepEqual(runners("zz-new.test.mjs", { excl: ["zz-new"], ciText: "      # node scripts/run-tests.mjs tests/zz-new.test.mjs\n" }), []);
    assert.deepEqual(runners("zz-new.test.mjs", { excl: ["zz-new"], ciText: "        run: node scripts/run-tests.mjs tests/zz-new.test.mjs\n" }), ["named step"]);
    assert.equal(/TEST_EXCLUDE:\s*([\w.,-]+)/.exec(code("          # TEST_EXCLUDE: a,b\n          TEST_EXCLUDE: c\n").join("\n"))[1], "c");
  });
  test("falsified: a new spec that is excluded and never named is reported uncovered", () => {
    assert.deepEqual(runners("zz-new.test.mjs", { excl: ["zz-new"] }), []);
    assert.deepEqual(runners("zz-new.test.mjs"), ["npm test"]);
  });
});
