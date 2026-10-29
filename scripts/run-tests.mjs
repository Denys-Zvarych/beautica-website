#!/usr/bin/env node
// Starts `wrangler dev` on the built site (dist/, headers + rewrites + the /api/delete-request Worker, all local), runs the
// node:test suites in tests/ against it, and always stops wrangler afterwards.
//
//   npm run build && npm test                  # everything
//   node scripts/run-tests.mjs tests/contract-delete-request.test.mjs   # one file
//   node scripts/run-tests.mjs --sequential tests/a.test.mjs tests/b.test.mjs   # one file at a time (a loaded machine, or files that compete for CPU)
//   node scripts/run-tests.mjs --concurrency 1|2|...  (default 2; env TEST_CONCURRENCY)   # how many files run at once
//   node scripts/run-tests.mjs --grep "font bytes" tests/booking-pages.test.mjs          # only tests whose name matches (node --test-name-pattern)
// The browser specs are slow (real flows, axe): run each on its own, as CI does (.github/workflows/ci.yml), and never put all of them in one
// call under a hard timeout; several files in one call share the same mock backend and wrangler, so each file must use slugs/phones of its own.
//
// Env for the tests: TEST_BASE_URL (wrangler origin), TEST_WRANGLER_LOG (its stdout/stderr, for "no PII in logs" checks).
// Browser: CHROMIUM_PATH, or a Chromium / Chrome found in the usual places (see tests/helpers/browser.mjs).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// A harness that was SIGKILLed (`timeout --signal=KILL`, a killed shell) cannot clean up: its wrangler + workerd process group keeps running on a
// random port. Every run therefore records its pid in its state dir (/tmp/beautica-wrangler-*/owner.pid) and, at startup, reaps the servers of
// runs whose owner is gone. Only dirs with this exact prefix under the temp dir are touched; a run whose owner is alive is never disturbed.
function reapStaleServers() {
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith("beautica-wrangler-")) continue;
    const dir = join(tmpdir(), name);
    let owner = NaN;
    try {
      owner = Number(readFileSync(join(dir, "owner.pid"), "utf8"));
    } catch {
      // Left by a harness from before owner.pid existed: only when it is clearly old (1 h), never a run that is starting right now.
      try {
        if (Date.now() - statSync(dir).mtimeMs < 3600_000) continue;
      } catch {
        continue;
      }
    }
    if (Number.isFinite(owner) && alive(owner)) continue;
    // The wrangler of that run carries its state dir on its command line; its group (workerd included) goes with it.
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (cmd.includes(dir) && cmd.includes("wrangler")) process.kill(-Number(pid), "SIGKILL");
      } catch {
        /* gone, or not ours */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
reapStaleServers();

// Stand-in backend for the booking-link pages: the Worker fetches its data from it (API_ORIGIN) and the browser calls it.
const mockApi = await startMockApi();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const logPath = join(mkdtempSync(join(tmpdir(), "beautica-wrangler-")), "wrangler.log");
writeFileSync(join(dirname(logPath), "owner.pid"), String(process.pid));
const log = createWriteStream(logPath);

const wrangler = spawn("npx", [
    "--no-install", "wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false",
    // Fresh local state per run: the Cache API persists on disk, and a page cached by an earlier run must never answer this one.
    "--persist-to", join(dirname(logPath), "state"),
    "--var", `API_ORIGIN:${mockApi.origin}`,
    // Cloudflare's always-pass test key: the tests serve a fake Turnstile script, so the whole widget + token path is exercised.
    "--var", "MEDIA_ORIGIN:https://media.beautica.test",
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
// Every way out that can be trapped (SIGKILL cannot: the next run's reapStaleServers() cleans that case).
process.on("exit", stop);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => (stop(), process.exit(130)));
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (err) => (console.error("run-tests:", err), stop(), process.exit(1)));

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
  // Flags first, then the files. `--flag value` pairs: --concurrency N, --grep PATTERN; `--sequential` = `--concurrency 1`.
  const args = process.argv.slice(2);
  const files = [];
  let concurrency = Number(process.env.TEST_CONCURRENCY ?? 2);
  let grep = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sequential") concurrency = 1;
    else if (args[i] === "--concurrency") concurrency = Number(args[++i]);
    else if (args[i] === "--grep") grep = args[++i] ?? "";
    else if (args[i].startsWith("--")) throw new Error(`unknown option ${args[i]}`);
    else files.push(args[i]);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a whole number >= 1");
  const targets = files.length ? files : readdirSync("tests").filter((f) => f.endsWith(".test.mjs") && !(process.env.TEST_EXCLUDE ?? "").split(",").filter(Boolean).some((x) => f.includes(x))).map((f) => join("tests", f));
  const run = spawn(process.execPath, ["--test", `--test-concurrency=${concurrency}`, "--test-reporter=spec", ...(grep ? [`--test-name-pattern=${grep}`] : []), ...targets], {
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
