// Single source for the analytics tags (phase 007). Public identifiers, safe in client code.
// Switching Umami region / self-hosting = change these (and the two Umami origins in the CSP: src/lib/securityHeaders.ts + public/_headers;
// tests/static-build.test.mjs checks the CSP covers them).

/** Umami Cloud (Hobby: one website, so previews are kept out by `data-domains`, not by a second website id). */
export const UMAMI_SCRIPT_SRC = "https://cloud.umami.is/script.js";
/** Where the script POSTs events (`<host>/api/send`; the script's default is gateway.umami.is). connect-src must allow it. */
export const UMAMI_HOST_URL = "https://gateway.umami.is";
export const UMAMI_WEBSITE_ID = "75c5e636-ec74-4d92-b0e0-5b852de5be46";
/** Only the production host reports; localhost and *.workers.dev previews never send. */
export const UMAMI_DOMAINS = "beautica.app";

/** Cloudflare Web Analytics, JS-snippet mode (automatic injection is off, so token routes stay clean). */
export const CF_BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
export const CF_BEACON_TOKEN = "cbe9cf31a9ee45fa80b74d3696eea297";
