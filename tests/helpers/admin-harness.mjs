// Starts the test-only /admin harness (scripts/render-admin.mjs --serve 0: real middleware + Access JWT, local mock catalog backend) on a free port.
// Start budget 280 s (render-admin itself retries a stuck wrangler start, 4 x 60 s at most): the CI runner and a loaded dev box start several wranglers at once and a start timeout would cancel the whole file.
// `env` adds harness variables (CATALOG_MOCK_ROWS, CATALOG_MOCK_CATEGORIES). Every request is checked against the mock's CALL LOG, not only the HTML.
import { spawn } from "node:child_process";
import { ROOT } from "./env.mjs";

export async function startAdminHarness(env = {}) {
  const child = spawn(process.execPath, ["scripts/render-admin.mjs", "--serve", "0"], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  const base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`admin harness did not start in 280 s:\n${log}`)), 280_000);
    const on = (d) => { log += d; const m = /(http:\/\/127\.0\.0\.1:\d+)\/admin/.exec(log); if (m) { clearTimeout(t); resolve(m[1]); } };
    child.stdout.on("data", on); child.stderr.on("data", (d) => { log += d; });
    child.once("exit", (c) => reject(new Error(`admin harness exited (${c}):\n${log}`)));
  });
  const res = async (r) => ({ status: r.status, location: r.headers.get("location") ?? "", setCookie: r.headers.get("set-cookie") ?? "", headers: r.headers, html: await r.text() });
  const calls = async () => (await fetch(`${base}/__mock/calls`)).json();
  const get = async (path, headers = {}) => res(await fetch(base + path, { redirect: "manual", headers }));
  const post = async (path, fields, headers = {}) => res(await fetch(base + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) }));
  const stop = () => { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } };
  return { base, calls, get, post, stop };
}
