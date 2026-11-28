// Regression (staging 2026-11-26): every /admin form POST from a REAL browser was 403 "Cross-site POST form submissions are forbidden".
// Under `Referrer-Policy: no-referrer` a browser serializes the Origin of a non-GET request as the string "null" (Fetch spec), which the CSRF check
// (src/middleware.ts) rightly rejects. Node `fetch` tests never saw it. Here a real Chromium submits the real forms through the BUILT Worker
// (scripts/render-admin.mjs --serve: real middleware + Access JWT, mock catalog backend) and the POST must be a 303, with a same-origin Origin.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ROOT, uk } from "./helpers/env.mjs";
import { launch } from "./helpers/browser.mjs";
import { HARNESS_START_MS } from "../scripts/lib/admin-harness.mjs";

let child, base, browser;

before(async () => {
  child = spawn(process.execPath, ["scripts/render-admin.mjs", "--serve", "0"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`admin harness did not start in ${HARNESS_START_MS / 1000} s:\n${log}`)), HARNESS_START_MS);
    const on = (d) => { log += d; const m = /(http:\/\/127\.0\.0\.1:\d+)\/admin/.exec(log); if (m) { clearTimeout(t); resolve(m[1]); } };
    child.stdout.on("data", on); child.stderr.on("data", (d) => { log += d; });
    child.once("exit", (c) => reject(new Error(`admin harness exited (${c}):\n${log}`)));
  });
  browser = await launch();
});
after(async () => {
  await browser?.close();
  if (child?.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {}
});

/** Submits `click` on a page and returns the document response of the resulting POST. */
async function submit(url, click) {
  const context = await browser.newContext();
  context.setDefaultTimeout(30_000);
  try {
    const page = await context.newPage();
    await page.goto(base + url);
    const posted = page.waitForResponse((r) => r.request().method() === "POST");
    await click(page);
    const res = await posted;
    return { status: res.status(), origin: await res.request().headerValue("origin"), location: (await res.allHeaders()).location };
  } finally { await context.close(); }
}

describe("admin forms submitted by a real browser", () => {
  test("approve dialog on /admin/requests: POST carries the real origin and answers 303", async () => {
    const r = await submit("/admin/requests?dlg=approve&id=CATEGORY:41", (p) => p.getByRole("button", { name: uk.admin.requests.approveConfirm }).click());
    assert.notEqual(r.origin, "null", "Origin must not be serialized as null");
    assert.equal(r.origin, base);
    assert.equal(r.status, 303, `got ${r.status}`);
  });

  test("reject dialog on /admin/requests: 303", async () => {
    const r = await submit("/admin/requests?dlg=reject&id=SERVICE_TYPE:9c1d2e3f-4a5b-4c6d-8e7f-001122334455", async (p) => { await p.getByLabel(uk.admin.requests.reason).fill("тест"); await p.getByRole("button", { name: uk.admin.requests.rejectConfirm }).click(); });
    assert.equal(r.status, 303, `got ${r.status}`);
    assert.equal(r.origin, base);
  });

  test("disable dialog on /admin/catalog: POST carries the real origin and answers 303", async () => {
    const r = await submit("/admin/catalog?dlg=disable&cat=BROWS", (p) => p.getByRole("button", { name: uk.admin.catalog.disableConfirm }).click());
    assert.notEqual(r.origin, "null", "Origin must not be serialized as null");
    assert.equal(r.origin, base);
    assert.equal(r.status, 303, `got ${r.status}`);
  });

  test("rename dialog on /admin/catalog: 303", async () => {
    const r = await submit("/admin/catalog?dlg=rename&cat=NAILS", (p) => p.getByRole("button", { name: uk.admin.catalog.save }).click());
    assert.equal(r.status, 303, `got ${r.status}`);
    assert.equal(r.origin, base);
  });

  test("the harness saw a real Origin, never the string null", async () => {
    const origins = await (await fetch(`${base}/__mock/origins`)).json();
    assert.ok(origins.length >= 4);
    assert.ok(origins.every((o) => o === base), `origins: ${JSON.stringify(origins)}`);
  });
});
