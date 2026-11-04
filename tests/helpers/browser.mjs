// Playwright (playwright-core + a system Chromium/Chrome) helpers. No test touches the network outside localhost:
// every context blocks other origins and reports them, tests that need the API mock it explicitly.
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { BASE, API_ORIGIN, MOCK_API } from "./env.mjs";

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
  context.setDefaultTimeout(15_000); // a broken feature fails in 15 s, not 30
  context.setDefaultNavigationTimeout(60_000); // wrangler cold-starts a route and a loaded runner stalls navigations: wait on the condition, not a tight clock
  const external = [];
  const problems = [];
  await context.route(
    (url) => url.origin !== BASE && url.origin !== MOCK_API,
    (route) => {
      external.push(route.request().url());
      return route.abort("blockedbyclient");
    },
  );
  // Phase 007: the two analytics scripts are answered with an empty script (registered after the block-all route: the latest route wins) (no network) and recorded apart from `external`,
  // so a test can assert "analytics on page X" / "none on token routes" without a real request leaving the machine.
  const analytics = [];
  await context.route(
    (url) => url.origin === "https://cloud.umami.is" || url.origin === "https://static.cloudflareinsights.com",
    (route) => {
      analytics.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
    },
  );
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(BASE)) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return { context, page, external, problems, analytics };
}

const CORS = { "access-control-allow-origin": BASE, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "*" };

/**
 * Mock of the backend guest-cancel endpoint (https://api.beautica.app/api/v1/book/cancel/{token}).
 * handlers: { get(req) -> {status, json?} | "abort", post(req) -> same }. Returns the recorded requests.
 * Registered on the context AFTER open(), so it wins over the block-everything route.
 */
export async function mockCancelApi(context, handlers) {
  const calls = [];
  calls.telegram = []; // phase 024: the cancel page also asks POST /api/v1/book/telegram/status; kept apart so `calls` stays the cancel API only
  await context.route(`${API_ORIGIN}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (new URL(req.url()).pathname.startsWith("/api/v1/book/telegram/")) {
      calls.telegram.push({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postData() });
      // Default = Telegram unavailable (the block stays hidden, no 404 noise); a test passes handlers.telegram(req) to say otherwise.
      const t = handlers.telegram ? await handlers.telegram(req) : { status: 200, json: { available: false, linked: false, offerChoice: false } };
      if (t === "abort") return route.abort("failed");
      return route.fulfill({ status: t.status, headers: { ...CORS, ...(t.json ? { "content-type": "application/json" } : {}) }, body: t.json ? JSON.stringify(t.json) : undefined });
    }
    calls.push({ method: req.method(), url: req.url(), headers: req.headers(), body: req.postData() });
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
