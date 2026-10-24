// Shared test plumbing: base URL of the local `wrangler dev` (set by scripts/run-tests.mjs), HTTP helpers, UI strings.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE = process.env.TEST_BASE_URL ?? "";
export const WRANGLER_LOG = process.env.TEST_WRANGLER_LOG ?? "";
/** Local stand-in backend (tests/helpers/mock-api.mjs) the Worker and the browser use for the booking-link pages. */
export const MOCK_API = process.env.TEST_API_ORIGIN ?? "";
/** API origin of the guest cancel page: the Worker's runtime API_ORIGIN, which in the tests is the mock backend. */
export const API_ORIGIN = MOCK_API || "https://api.beautica.app";
export const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

/** UI copy: read from the same file the site renders from, so labels are never retyped (exact copy is covered by headers-seo). */
export const uk = JSON.parse(readFileSync(join(ROOT, "src/i18n/uk.json"), "utf8"));

export function requireBase() {
  if (!BASE) throw new Error("TEST_BASE_URL is not set: run these through `npm test` (scripts/run-tests.mjs), not `node --test` directly");
  return BASE;
}

/** Raw HTTP GET/HEAD: keeps duplicate headers apart (fetch() folds them into one comma-joined value). */
export function rawRequest(path, { method = "GET", headers = {} } = {}) {
  const url = new URL(path, requireBase());
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const all = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) all.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          /** every value of a header, in order (length 1 = sent once) */
          all: (name) => all.filter(([k]) => k === name.toLowerCase()).map(([, v]) => v),
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let ipCounter = 0;
/** A fresh fake client IP (cf-connecting-ip) so a test owns its rate-limit bucket regardless of run order. */
export const freshIp = () => `10.${process.pid % 250}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;
