// Denial-reason logging, route level: the BUILT Worker (scripts/render-admin.mjs --serve with RENDER_ADMIN_ANON=1, so the proxy sends no Access JWT).
// A refused /admin request still answers the same plain 404, and the Worker's console.warn shows exactly one throttled `admin_denied` line.
// Needs a built dist/. Nothing leaves localhost; waits on the log file, never a fixed sleep.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_CSP } from "../src/lib/securityHeaders.ts";
import { notFound } from "../src/lib/admin/access.ts";
import { ROOT } from "./helpers/env.mjs";

const tmp = mkdtempSync(join(tmpdir(), "admin-denial-"));
const logFile = join(tmp, "worker.log");
let child, base;

const workerLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "").replace(/\x1b\[[0-9;]*m/g, ""); // wrangler colours its WARNING prefix
const deniedLines = () => [...workerLog().matchAll(/\{"event":"admin_denied"[^}\n]*\}/g)].map((m) => JSON.parse(m[0]));
const requestLines = () => (workerLog().match(/GET \/admin\/requests 404/g) ?? []).length; // wrangler prints it AFTER the request ran, so after any log call
const until = async (cond, what, ms = 15_000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (cond()) return; assert.fail(`timed out: ${what}\n${workerLog()}`); };

before(async () => {
  child = spawn(process.execPath, ["scripts/render-admin.mjs", "--serve", "0"], { cwd: ROOT, env: { ...process.env, RENDER_ADMIN_ANON: "1", RENDER_ADMIN_LOG: logFile }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`admin harness did not start in 280 s:\n${out}`)), 280_000);
    const on = (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+)\/admin/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } };
    child.stdout.on("data", on);
    child.stderr.on("data", (d) => { out += d; });
    child.once("exit", (c) => reject(new Error(`admin harness exited (${c}):\n${out}`)));
  });
});
after(() => { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } rmSync(tmp, { recursive: true, force: true }); });

describe("/admin/requests without an Access assertion (built Worker)", () => {
  test("denied: the unchanged 404 body and headers", async () => {
    const res = await fetch(`${base}/admin/requests`, { redirect: "manual" });
    const ref = notFound();
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not Found");
    assert.equal(res.headers.get("content-type"), ref.headers.get("content-type"));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.equal(res.headers.get("content-security-policy"), ADMIN_CSP);
  });

  test("exactly one admin_denied line, reason no_assertion_header, nothing else in it", async () => {
    await until(() => deniedLines().length >= 1, "first admin_denied line");
    assert.deepEqual(deniedLines(), [{ event: "admin_denied", reason: "no_assertion_header" }]);
  });

  test("a second identical request within 60 s answers 404 again and emits no new line", async () => {
    await until(() => requestLines() >= 1, "first request line");
    const res = await fetch(`${base}/admin/requests`, { redirect: "manual" });
    assert.equal(res.status, 404);
    await until(() => requestLines() >= 2, "second request line (its log call, if any, came before it)");
    assert.equal(deniedLines().length, 1, "throttled: still one line");
  });
});
