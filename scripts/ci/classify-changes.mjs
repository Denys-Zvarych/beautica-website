#!/usr/bin/env node
// Phase 055 (CI minutes): decides whether the heavy CI jobs (e2e, e2e_booking, lighthouse) must run for a PR. Called by the `changes` job
// of .github/workflows/ci.yml (the copy from the BASE branch when it has one). Writes `heavy=true|false` and `reason=<why>` to $GITHUB_OUTPUT.
//
// Deny by default: `heavy=false` only when (a) the PR is a draft (the gate then FAILS `DEFERRED: draft`, see gate.mjs) or (b) EVERY changed file
// is on the allow-list of files that cannot change dist/. Anything else, and every error or doubt, is `heavy=true`.
//
// Order (first match wins): base main -> true | classifier error -> true | label full-ci -> true | empty/invalid file list -> true |
// draft -> false (reason draft) | every file allow-listed -> false (reason allowlist) | otherwise true.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Files that cannot change dist/ or a test result of the heavy jobs: root *.md, docs/** (except docs/claims.md), LICENSE, .gitignore, .github/ISSUE_TEMPLATE/**, .claude/**. */
export const ALLOW_EXACT = Object.freeze(["LICENSE", ".gitignore"]);
export const ALLOW_PREFIXES = Object.freeze(["docs/", ".github/ISSUE_TEMPLATE/", ".claude/"]);
/** Carved out of an allowed prefix: read by a heavy spec (tests/booking-lib.test.mjs), so a change to it must run the heavy jobs. */
export const ALLOW_DENY = Object.freeze(["docs/claims.md"]);

export function isAllowListed(path) {
  if (typeof path !== "string" || path === "") return false;
  if (/[\\\0\n\r]/.test(path) || path.startsWith("/")) return false;
  const parts = path.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) return false; // traversal or odd spelling: never skip on a doubt
  if (ALLOW_DENY.includes(path)) return false;
  if (parts.length === 1) return ALLOW_EXACT.includes(path) || /^[^/]+\.md$/.test(path);
  return ALLOW_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * @param {{ files?: string[], baseRef?: string, draft?: boolean, labels?: string[], error?: unknown }} i
 * @returns {{ heavy: boolean, reason: string }}
 */
export function classify({ files, baseRef, draft = false, labels = [], error = null } = {}) {
  if (baseRef === "main") return { heavy: true, reason: "promotion" }; // dev -> main always runs everything (draft, label and files irrelevant)
  if (error) return { heavy: true, reason: "classifier-error" };
  if (baseRef !== "dev") return { heavy: true, reason: "unknown-base" };
  if (Array.isArray(labels) && labels.includes("full-ci")) return { heavy: true, reason: "full-ci" };
  if (!Array.isArray(files) || files.length === 0) return { heavy: true, reason: "empty-diff" };
  if (draft === true) return { heavy: false, reason: "draft" };
  if (files.every(isAllowListed)) return { heavy: false, reason: "allowlist" };
  return { heavy: true, reason: "site-files" };
}

function main() {
  const env = process.env;
  let result;
  try {
    const sha = /^[0-9a-f]{40}$/;
    if (!sha.test(env.BASE_SHA ?? "") || !sha.test(env.HEAD_SHA ?? "")) throw new Error("BASE_SHA / HEAD_SHA missing or not a 40-char sha");
    // --no-renames: a rename lists BOTH paths, so moving src/x into docs/ is still a site-file change.
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${env.BASE_SHA}...${env.HEAD_SHA}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const files = out.split("\0").filter(Boolean);
    const labels = env.LABELS_JSON ? JSON.parse(env.LABELS_JSON) : [];
    if (!Array.isArray(labels)) throw new Error("LABELS_JSON is not an array");
    result = classify({ files, baseRef: env.BASE_REF, draft: env.DRAFT === "true", labels });
  } catch (e) {
    console.error(`classify-changes: ${e.message}: running everything`);
    result = { heavy: true, reason: "classifier-error" };
  }
  console.log(`classify-changes: heavy=${result.heavy} reason=${result.reason}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `heavy=${result.heavy}\nreason=${result.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
