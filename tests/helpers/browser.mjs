// Playwright (playwright-core + a system Chromium/Chrome) helpers. No test touches the network outside localhost:
// every context blocks other origins and reports them, tests that need the API mock it explicitly.
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { BASE, API_ORIGIN } from "./env.mjs";

const CANDIDATES = ["/snap/bin/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];

export async function launch() {
  const executablePath = process.env.CHROMIUM_PATH ?? CANDIDATES.find(existsSync);
  if (!executablePath) throw new Error("No Chromium found: set CHROMIUM_PATH");
  return chromium.launch({ executablePath, args: ["--no-sandbox"] });
}

/**
 * New context + page for the local site. Non-local requests are aborted and listed in `external`;
 * console errors, page errors and failed local requests are collected in `problems` (assert it is empty).
 */
export async function open(browser, { width = 360, height = 800, ...opts } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...opts });
  context.setDefaultTimeout(10_000); // a broken feature fails in 10 s, not 30
  const external = [];
  const problems = [];
  await context.route(
    (url) => url.origin !== BASE,
    (route) => {
      external.push(route.request().url());
      return route.abort("blockedbyclient");
    },
  );
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(BASE)) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return { context, page, external, problems };
}

const CORS = { "access-control-allow-origin": BASE, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "*" };

/**
 * Mock of the backend guest-cancel endpoint (https://api.beautica.app/api/v1/book/cancel/{token}).
 * handlers: { get(req) -> {status, json?} | "abort", post(req) -> same }. Returns the recorded requests.
 * Registered on the context AFTER open(), so it wins over the block-everything route.
 */
export async function mockCancelApi(context, handlers) {
  const calls = [];
  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    calls.push({ method: req.method(), url: req.url(), headers: req.headers() });
    const h = handlers[req.method().toLowerCase()];
    const out = h ? await h(req) : { status: 404 };
    if (out === "abort") return route.abort("failed");
    return route.fulfill({
      status: out.status,
      headers: { ...CORS, ...(out.json ? { "content-type": "application/json" } : {}) },
      body: out.json ? JSON.stringify(out.json) : undefined,
    });
  });
  return calls;
}

export const visibleBox = async (locator) => {
  const b = await locator.boundingBox();
  return !!b && b.width > 0 && b.height > 0;
};
