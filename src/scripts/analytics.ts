// Loaded by Analytics.astro on every page that carries analytics (never on token routes). Phase 007 / verifier: the two tags in <head>
// pushed LCP past 2 s, so they are injected AFTER the load event, when the browser is idle, one per idle slot (a task each, not one long one).
// Attributes are the same as a static tag: `data-domains` keeps localhost / previews out, `data-exclude-search` / `-hash` strip the query and
// the fragment, the Cloudflare token rides in `data-cf-beacon`. NO static imports (a module graph discovered during load cost ~290 ms of LCP):
// track.ts is only pulled in by pages that fire events themselves; it learns about Umami through the `beautica:umami` event below. A dynamic
// import() here would drag Vite's preload helper in as a static import, so the delegated `data-event` listener (track.ts `initClickEvents`)
// is wired by the store-launch phase, on the page that gets the store buttons.
import { UMAMI_SCRIPT_SRC, UMAMI_HOST_URL, UMAMI_WEBSITE_ID, UMAMI_DOMAINS, CF_BEACON_SRC, CF_BEACON_TOKEN } from "../config/analytics.mjs";

/** Token prefixes (mirrors TOKEN_PATH in src/lib/securityHeaders.ts). A static 404 shell can be served under them, so the loader checks the address itself. */
const TOKEN_PATH = /^\/(?:book\/cancel|invite|bookings|l)\//;

const AFTER_LOAD_MS = 1500;

const idle = (fn: () => void): void => {
  if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 3000 });
  else setTimeout(fn, 300);
};

function injectUmami(): void {
  const s = document.createElement("script");
  s.src = UMAMI_SCRIPT_SRC;
  s.defer = true;
  s.setAttribute("data-website-id", UMAMI_WEBSITE_ID);
  s.setAttribute("data-host-url", UMAMI_HOST_URL);
  s.setAttribute("data-domains", UMAMI_DOMAINS);
  s.setAttribute("data-exclude-search", "true");
  s.setAttribute("data-exclude-hash", "true");
  const done = (ok: boolean) => {
    document.dispatchEvent(new CustomEvent("beautica:umami", { detail: ok })); // track.ts (booking pages) flushes or drops its queue
    idle(injectBeacon); // its own idle slot: never in the same task as Umami's start-up
  };
  s.addEventListener("load", () => done(true), { once: true });
  s.addEventListener("error", () => done(false), { once: true });
  document.head.append(s);
}

function injectBeacon(): void {
  const s = document.createElement("script");
  s.type = "module";
  s.src = CF_BEACON_SRC;
  s.setAttribute("data-cf-beacon", JSON.stringify({ token: CF_BEACON_TOKEN }));
  document.head.append(s);
}

if (!TOKEN_PATH.test(location.pathname)) {
  // 1.5 s after load, then an idle slot. Lighthouse's simulated LCP counts requests that a script starts shortly after load (+300 ms on
  // text pages, measured 800 ms = flaky, 1500 ms = clean); a visitor who leaves within 1.5 s of load is not counted.
  const start = () => setTimeout(() => idle(injectUmami), AFTER_LOAD_MS);
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
}
