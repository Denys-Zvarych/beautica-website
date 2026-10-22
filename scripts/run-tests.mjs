#!/usr/bin/env node
// Starts `wrangler dev` on the built site (dist/, headers + rewrites + the /api/delete-request Worker, all local), runs the
// node:test suites in tests/ against it, and always stops wrangler afterwards.
//
//   npm run build && npm test                  # everything
//   node scripts/run-tests.mjs tests/contract-delete-request.test.mjs   # one file
//
// Env for the tests: TEST_BASE_URL (wrangler origin), TEST_WRANGLER_LOG (its stdout/stderr, for "no PII in logs" checks).
// Browser: CHROMIUM_PATH, or a Chromium / Chrome found in the usual places (see tests/helpers/browser.mjs).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startMockApi } from "../tests/helpers/mock-api.mjs";

if (!existsSync("dist/server/wrangler.json")) {
  console.error("run-tests: dist/ is missing, run `npm run build` first");
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// Stand-in backend for the booking-link pages: the Worker fetches its data from it (API_ORIGIN) and the browser calls it.
const mockApi = await startMockApi();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const logPath = join(mkdtempSync(join(tmpdir(), "beautica-wrangler-")), "wrangler.log");
const log = createWriteStream(logPath);

const wrangler = spawn("npx", [
    "--no-install", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false",
    // Fresh local state per run: the Cache API persists on disk, and a page cached by an earlier run must never answer this one.
    "--persist-to", join(dirname(logPath), "state"),
    "--var", `API_ORIGIN:${mockApi.origin}`,
    // Cloudflare's always-pass test key: the tests serve a fake Turnstile script, so the whole widget + token path is exercised.
    "--var", "TURNSTILE_SITE_KEY:1x00000000000000000000AA",
    "--var", "BOOKING_INFO_WORKER_KEY:test-worker-key-0123456789012345678901",
  ], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // own process group: workerd children die with it
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
});
wrangler.stdout.pipe(log);
wrangler.stderr.pipe(log);
let exited = false;
wrangler.on("exit", () => (exited = true));

const stop = () => {
  mockApi.close();
  if (exited) return;
  try {
    process.kill(-wrangler.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stop(), process.exit(130)));

async function waitReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error("wrangler dev exited early:\n" + readFileSync(logPath, "utf8").slice(-2000));
    try {
      if ((await fetch(base + "/", { signal: AbortSignal.timeout(2000) })).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("wrangler dev did not become ready in 90 s:\n" + readFileSync(logPath, "utf8").slice(-2000));
}

let code = 1;
try {
  await waitReady();
  const files = process.argv.slice(2);
  const targets = files.length ? files : readdirSync("tests").filter((f) => f.endsWith(".test.mjs") && !(process.env.TEST_EXCLUDE ?? "").split(",").filter(Boolean).some((x) => f.includes(x))).map((f) => join("tests", f));
  const run = spawn(process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=spec", ...targets], {
    stdio: "inherit",
    env: { ...process.env, TEST_BASE_URL: base, TEST_WRANGLER_LOG: logPath, TEST_API_ORIGIN: mockApi.origin },
  });
  code = await new Promise((resolve) => run.on("exit", (c) => resolve(c ?? 1)));
} catch (err) {
  console.error("run-tests:", err.message);
} finally {
  stop();
}
process.exit(code);
