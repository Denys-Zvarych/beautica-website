#!/usr/bin/env node
// Phase 055: the `CI Gate` job (the one required check, OD-1). Summarises the jobs it `needs` and decides merge-readiness.
// Run from the BASE branch copy of this file (the head copy only while the base has none: the PR that introduces it).
//
// Env: NEEDS_JSON (toJSON(needs)), PR_NUMBER, GITHUB_REPOSITORY, GH_TOKEN (read the live draft flag via `gh`), GITHUB_STEP_SUMMARY.
//
// Passes only when:
//   * `changes` and `site` succeeded and nothing failed or was cancelled;
//   * heavy != "false" (empty or unknown counts as true): e2e, e2e_booking, lighthouse all succeeded (a skipped heavy job = fail);
//   * heavy == "false" with reason `allowlist` (every changed file is on the allow-list).
// A `draft` deferral ALWAYS fails: `DEFERRED: draft`, or `STALE DEFERRED` when the live PR is not a draft (or the API cannot say): fail closed.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HEAVY = Object.freeze(["e2e", "e2e_booking", "lighthouse"]);
export const REQUIRED = Object.freeze(["changes", "site", ...HEAVY]);

/**
 * @param {{ needs: Record<string, { result?: string, outputs?: Record<string, string> }>, getLiveDraft: () => string }} i
 *   getLiveDraft returns "true" | "false" | other text, or throws; it is only called for a draft deferral.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function evaluate({ needs, getLiveDraft }) {
  const errors = [];
  const n = needs && typeof needs === "object" ? needs : {};
  const result = (j) => (typeof n[j]?.result === "string" ? n[j].result : "missing");

  for (const j of REQUIRED) {
    const r = result(j);
    if (r === "failure" || r === "cancelled") errors.push(`${j}: ${r}`);
    else if (r === "missing") errors.push(`${j}: result missing`);
    else if (r !== "success" && r !== "skipped") errors.push(`${j}: unexpected result '${r}'`);
  }
  if (result("changes") !== "success") errors.push("changes must succeed (it decides what runs)");
  if (result("site") !== "success") errors.push(`site must succeed (always required), got '${result("site")}'`);

  const heavy = n.changes?.outputs?.heavy !== "false"; // empty, missing or anything but the literal "false" = run everything
  const reason = n.changes?.outputs?.reason ?? "";
  if (heavy) {
    for (const j of HEAVY) if (result(j) !== "success") errors.push(`heavy=true but ${j} is '${result(j)}': required work did not pass`);
  } else if (reason === "draft") {
    let live = "";
    try {
      live = String(getLiveDraft()).trim();
    } catch (e) {
      errors.push(`STALE DEFERRED: the live draft check failed (${String(e.message).split("\n")[0]}); failing closed`);
    }
    if (live === "true") errors.push("DEFERRED: draft");
    else if (!errors.some((x) => x.startsWith("STALE DEFERRED"))) errors.push(`STALE DEFERRED: the PR is no longer a draft (live draft='${live}'); re-run CI on the ready head`);
  } else if (reason !== "allowlist") {
    errors.push(`heavy=false with unknown reason '${reason}'`);
  }
  return { ok: errors.length === 0, errors };
}

function liveDraftViaGh() {
  const { PR_NUMBER = "", GITHUB_REPOSITORY = "" } = process.env;
  if (!/^\d+$/.test(PR_NUMBER) || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY)) throw new Error("PR number or repository invalid");
  return execFileSync("gh", ["api", `repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`, "--jq", ".draft"], { encoding: "utf8", timeout: 30_000 });
}

function main() {
  let needs;
  try {
    needs = JSON.parse(process.env.NEEDS_JSON ?? "");
  } catch {
    console.error("::error::CI Gate: NEEDS_JSON missing or invalid");
    process.exit(1);
  }
  const { ok, errors } = evaluate({ needs, getLiveDraft: liveDraftViaGh });
  const lines = [`### CI Gate: ${ok ? "PASS" : "FAIL"}`, "", ...REQUIRED.map((j) => `- ${j}: ${needs[j]?.result ?? "missing"}`), `- heavy: ${needs.changes?.outputs?.heavy ?? ""} (${needs.changes?.outputs?.reason ?? ""})`, ...errors.map((e) => `- **${e}**`)];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  for (const e of errors) console.error(`::error::${e}`);
  console.log(lines.join("\n"));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
