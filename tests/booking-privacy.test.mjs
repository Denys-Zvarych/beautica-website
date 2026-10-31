// Phase 009 QA: where the sensitive values of a guest booking are ALLOWED to go, asserted by following each value through every
// request the browser makes (url, headers, body), the mock backend's log, browser storage and the analytics hook.
//   Turnstile token  -> only the body of POST {API_ORIGIN}/api/v1/book/otp/send
//   guest phone      -> only the bodies of POST /otp/send and /otp/verify on API_ORIGIN (never the booking POST: the phone is the SMS session's)
//   guest token      -> only the Authorization header of POST /booking on API_ORIGIN
//   name / surname / comment -> only the booking POST body
// plus the analytics funnel: documented event names, counts/codes only. Real browser, mock backend, nothing leaves localhost.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launch, open } from "./helpers/browser.mjs";
import { BASE, MOCK_API, ROOT } from "./helpers/env.mjs";
import { mockLog, callsTo, driveTo, PNG, FAKE_TURNSTILE } from "./helpers/book.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

// Every event also carries the link context {kind, source} (phase 013: master|salon, copy|share|none), added by track.ts.
const CTX = ["kind", "source"];
const EVENTS = {
  link_open: ["referrer_host"],
  profile_view: ["slug"],
  service_selected: ["count"],
  slot_selected: ["days_ahead"],
  otp_requested: [],
  otp_failed: [],
  otp_verified: [],
  booking_confirmed: ["services_count"],
  booking_error: ["code"],
  reminder_channel_telegram_click: [],
  reminder_channel_unlink: [],
};

/** A page with an analytics spy (window.umami), the fake media + Turnstile origins, and a record of every request with its headers. */
async function withSpy(slug, fn) {
  const env = await open(browser, { width: 360, height: 800 });
  await env.context.addInitScript(() => {
    window.__events = [];
    window.umami = { track: (e, p) => window.__events.push({ e, p }) };
  });
  await env.context.route("https://media.beautica.test/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await env.context.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_TURNSTILE }));
  const sent = [];
  env.page.on("request", async (r) => sent.push({ url: r.url(), method: r.method(), post: r.postData() ?? "", headers: await r.allHeaders().catch(() => r.headers()) }));
  await env.page.goto(`${BASE}/book/${slug}`, { waitUntil: "load" });
  try {
    await fn(env, sent);
  } finally {
    await env.context.close();
  }
}
const snapshotState = (page) => page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie, h: history.state, u: location.href, n: window.name, e: window.__events }));
const holders = (sent, needle) => sent.filter((r) => [r.url, r.post, JSON.stringify(r.headers)].some((v) => decodeURIComponent(v).includes(needle)));
/** Where a value shows up: "body POST API/path" / "header ..." / "url ..." (the query string counts as the URL). */
const placesOf = (sent, needle) => [...new Set(sent.flatMap((r) => [[r.post, "body"], [JSON.stringify(r.headers), "header"], [r.url, "url"]].filter(([v]) => decodeURIComponent(v).includes(needle)).map(([, w]) => `${w} ${route(r)}`)))].sort();
const route = (r) => `${r.method} ${new URL(r.url).origin === MOCK_API ? "API" : new URL(r.url).origin}${new URL(r.url).pathname.replace(/oksana-ab12|conflict-9999/, "{slug}")}`;

describe("sensitive values reach only the endpoints that need them", () => {
  test("Turnstile token -> POST /otp/send body on the API origin, nowhere else (not the booking, not a URL, not storage, not analytics)", async () => {
    await withSpy("oksana-ab12", async ({ page }, sent) => {
      await driveTo(page, "confirm", { contact: { name: "Токен", surname: "Тестова", phone: "671230001" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.deepEqual(placesOf(sent, "TOKEN-"), ["body POST API/api/v1/book/otp/send"], "the token must be in the /otp/send body only (not its URL, not a header)");
      assert.ok(holders(sent, "TOKEN-").every((r) => JSON.parse(r.post).turnstileToken?.startsWith("TOKEN-")), "and as the turnstileToken field");
      assert.equal((await snapshotState(page)).includes("TOKEN-"), false, "never in storage / history / url / analytics");
      const log = await mockLog((e) => e.body?.phone === "+380671230001" || e.path.includes("oksana-ab12/booking"));
      assert.equal(callsTo(log, "POST", "/booking").some((e) => JSON.stringify(e.body).includes("TOKEN-")), false, "the booking POST carries no Turnstile token");
    });
  });

  test("guest phone -> bodies of /otp/send and /otp/verify only; never a URL, header, the booking POST, storage or analytics", async () => {
    await withSpy("oksana-ab12", async ({ page }, sent) => {
      await driveTo(page, "confirm", { contact: { name: "Номер", surname: "Приватна", phone: "671230002" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      for (const form of ["671230002", "380671230002", "67 123 00 02", "067 123 00 02"])
        assert.ok(placesOf(sent, form).every((w) => ["body POST API/api/v1/book/otp/send", "body POST API/api/v1/book/otp/verify"].includes(w)), `${form} appears in: ${placesOf(sent, form).join(", ")}`);
      assert.deepEqual(placesOf(sent, "+380671230002"), ["body POST API/api/v1/book/otp/send", "body POST API/api/v1/book/otp/verify"], "the phone does go to send and verify (the spy sees it) and nowhere else, no URL, no header (incl. Referer)");
      const state = await snapshotState(page);
      for (const form of ["671230002", "67 123 00 02", "Приватна"]) assert.equal(state.includes(form), false, `${form} leaked into storage/history/url/analytics`);
      const booking = callsTo(await mockLog((e) => e.path.includes("oksana-ab12/booking") && e.body?.surname === "Приватна"), "POST", "/booking").at(-1);
      assert.ok(booking, "the booking was posted");
      assert.equal(JSON.stringify(booking.body).includes("671230002"), false, "the booking body has no phone (the guest token identifies it)");
    });
  });

  test("guest token -> the Authorization header of POST /booking only", async () => {
    await withSpy("oksana-ab12", async ({ page }, sent) => {
      await driveTo(page, "confirm", { contact: { name: "Сесія", phone: "671230003" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.deepEqual(placesOf(sent, "guest-token-ok"), ["header POST API/api/v1/book/{slug}/booking"], "the guest token goes in the booking's Authorization header only");
      assert.equal((await snapshotState(page)).includes("guest-token"), false);
    });
  });

  test("name, surname and comment -> the booking POST body only", async () => {
    await withSpy("oksana-ab12", async ({ page }, sent) => {
      await driveTo(page, "confirm", { contact: { name: "ІмяУнікальне", surname: "ПрізвищеУнікальне", phone: "671230004" } });
      await page.fill("#comment", "КоментарУнікальний");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      for (const v of ["ІмяУнікальне", "ПрізвищеУнікальне", "КоментарУнікальний"]) {
        assert.deepEqual(placesOf(sent, v), ["body POST API/api/v1/book/{slug}/booking"], v);
      }
      const state = await snapshotState(page);
      for (const v of ["ІмяУнікальне", "ПрізвищеУнікальне", "КоментарУнікальний"]) assert.equal(state.includes(v), false, `${v} leaked into storage/history/url/analytics`);
    });
  });

  test("the SMS code goes to /otp/verify only", async () => {
    await withSpy("oksana-ab12", async ({ page }, sent) => {
      await driveTo(page, "otp", { contact: { name: "Код", phone: "671230005" }, code: "482915" });
      await page.click("#cta-otp");
      await page.waitForSelector("#confirm-card", { state: "visible" });
      assert.deepEqual(placesOf(sent, "482915"), ["body POST API/api/v1/book/otp/verify"]);
      assert.equal((await snapshotState(page)).includes("482915"), false);
    });
  });
});

describe("analytics funnel: documented events, counts and codes only", () => {
  test("a booking emits exactly the funnel, each event with only its documented props, none of them personal", async () => {
    await withSpy("oksana-ab12", async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Аналітика", surname: "Анонімна", phone: "671230006" } });
      await page.fill("#comment", "секретний коментар");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const events = await page.evaluate(() => window.__events);
      assert.deepEqual(events.map((x) => x.e), ["link_open", "profile_view", "service_selected", "slot_selected", "otp_requested", "otp_verified", "booking_confirmed"]);
      for (const { e, p } of events) {
        assert.deepEqual(Object.keys(p ?? {}).sort(), [...EVENTS[e], ...CTX].sort(), `${e}: props`);
        for (const v of Object.values(p ?? {})) assert.ok(typeof v === "number" || (typeof v === "string" && v.length <= 60), `${e}: ${v}`);
      }
      assert.deepEqual(events.find((x) => x.e === "profile_view").p, { slug: "oksana-ab12", kind: "master", source: "none" });
      assert.deepEqual(events.find((x) => x.e === "booking_confirmed").p, { services_count: 1, kind: "master", source: "none" });
      const text = JSON.stringify(events);
      for (const pii of ["Аналітика", "Анонімна", "671230006", "380671230006", "коментар", "guest-token", "TOKEN-", "123456", "b0b0b0b0", "123e4567"]) assert.equal(text.includes(pii), false, `analytics carries ${pii}`);
    });
  });

  test("a wrong code emits otp_failed; a taken slot emits booking_error with code 409 (codes, never messages)", async () => {
    await withSpy("conflict-9999", async ({ page }) => {
      await driveTo(page, "otp", { contact: { name: "Помилка", phone: "671230007" }, code: "000000" });
      await page.click("#cta-otp");
      await page.waitForSelector("#otp-wrong", { state: "visible" });
      assert.ok((await page.evaluate(() => window.__events)).some((x) => x.e === "otp_failed"));
    });
    await withSpy("conflict-9999", async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Конфлікт", phone: "671230008" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#time-conflict", { state: "visible" });
      const err = (await page.evaluate(() => window.__events)).find((x) => x.e === "booking_error");
      assert.deepEqual(err.p, { code: 409, kind: "master", source: "none" });
    });
  });

  test("every track() call in the island uses a documented event and only documented props (a new event must be added here and in README § 10)", () => {
    const dir = join(ROOT, "src/scripts");
    const files = [...readdirSync(dir).map((f) => join(dir, f)), ...readdirSync(join(dir, "booking")).map((f) => join(dir, "booking", f))].filter((f) => f.endsWith(".ts"));
    const calls = [];
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\btrack\(\s*"(\w+)"\s*(?:,\s*\{([^}]*)\})?\s*\)/g)) calls.push({ f, event: m[1], props: (m[2] ?? "").split(",").flatMap((part) => /^\s*(\w+)\s*:/.exec(part)?.[1] ?? []) });
    assert.ok(calls.length >= 8, `found ${calls.length} track() calls: the scanner is broken`);
    for (const c of calls) {
      assert.ok(c.event in EVENTS, `${c.f}: undocumented event ${c.event}`);
      assert.ok(c.props.every((p) => EVENTS[c.event].includes(p)), `${c.f}: ${c.event} sends undocumented props ${c.props}`);
    }
  });
});

describe("the SSR page", () => {
  test("renders the policy version the consent records and never leaks the Worker's secret key", async () => {
    const html = await (await fetch(`${BASE}/book/oksana-ab12`)).text();
    assert.ok(html.includes(`data-policy="${PRIVACY_POLICY_VERSION}"`), "data-policy is the current PRIVACY_POLICY_VERSION");
    assert.equal(html.includes("test-worker-key"), false, "BOOKING_INFO_WORKER_KEY must stay server-side");
  });
});
