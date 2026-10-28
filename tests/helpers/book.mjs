// Helpers for the booking-link tests: the mock backend's request log, a page with the fake media + Turnstile origins, day picking.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { open } from "./browser.mjs";
import { BASE, MOCK_API, TEST_NOW } from "./env.mjs";

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO0Dwv7DwAEGAHYhxX0pQAAAABJRU5ErkJggg==", "base64");
// Records the render options in window.__tsOpts. Like the real widget: render() and every reset() deliver a fresh single-use token through the callback.
export const FAKE_TURNSTILE = `(function(){var cb,n=0;function give(){var t="TOKEN-"+(++n);setTimeout(function(){cb(t)},5)}window.turnstile={render:function(el,o){window.__tsOpts=o;cb=o.callback;give();var f=document.createElement("iframe");f.title="fake turnstile";f.style.cssText="width:300px;height:65px;border:0";el.appendChild(f);return "w1"},reset:function(){give()}};})();`;

/** Every request the mock backend has seen, optionally filtered. */
export async function mockLog(filter = () => true, since = 0) {
  const log = await (await fetch(`${MOCK_API}/__mock/log`)).json();
  return log.slice(since).filter(filter);
}
/** The log length now: later `mockLog(filter, mark)` calls see only what came after. Tests must NOT clear the shared log (POST /__mock/reset):
 *  other test files run against the same mock at the same time (--test-concurrency) and read it, so a reset deletes THEIR requests (flaky "0 !== 1"). */
export const logMark = async () => (await mockLog()).length;
export const callsTo = (log, method, pathPart) => log.filter((e) => e.method === method && e.path.includes(pathPart));

/** A Playwright page on a booking-link page, with the media origin and Turnstile faked (nothing leaves the machine). */
export async function bookPage(browser, slug, { width = 360, height = 800, turnstile = "ok", js = true, path, init, clock = true, ...context } = {}) {
  const env = await open(browser, { width, height, javaScriptEnabled: js, ...context }); // `context`: any other Playwright context option (e.g. reducedMotion)
  // The browser's "today" is TEST_NOW (time still flows from there), the same day the mock backend's bookable-days window starts at: the calendar does not depend on the real date.
  if (clock) await env.context.clock.install({ time: new Date(TEST_NOW) });
  if (init) await env.context.addInitScript(init);
  const turnstileRequests = [];
  await env.context.route("https://media.beautica.test/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await env.context.route("https://challenges.cloudflare.com/**", (r) => {
    turnstileRequests.push(r.request().url());
    return turnstile === "ok" ? r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_TURNSTILE }) : r.abort("failed");
  });
  const res = await env.page.goto(`${BASE}${path ?? `/book/${slug}`}`, { waitUntil: "load" });
  // The tabs are wired by a dynamic import after `load` (initTabs sets role=tablist, then selects tab 0): a tap before that is undone by it. Wait for it.
  if (js && (await env.page.locator("[data-tabs]").count())) await env.page.waitForSelector("[data-tabs][role=tablist]", { state: "attached" });
  return { ...env, res, turnstileRequests };
}

/** First day in the booking window that has slots in the mock (not a Sunday, not a Saturday, not today: the bookable-days answer arrives after the grid renders and may grey a Saturday out, so tests never race it): "YYYY-MM-DD". */
// Saturdays are skipped on purpose: the mock greys them out for the pedicure service once the async bookable-days answer lands, so a click can race it.
// A test that needs a Saturday must go through the pedicure path and wait for that answer explicitly.
export async function pickableDay(page, { sunday = false, nth = 0 } = {}) {
  const find = () =>
    page.evaluate(([sun, n]) => {
      const days = [...document.querySelectorAll(".dbtn.ok")].map((b) => b.dataset.day);
      const today = document.querySelector(".dbtn.today")?.dataset.day;
      const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
      const ok = days.filter((d) => d !== today && (dow(d) === 0) === sun && dow(d) !== 6);
      return ok[n];
    }, [sunday, nth]);
  // Near the end of a month (e.g. today is the month's last Sunday) the visible month has no such day left: go to the next month (inside the 60-day window).
  let day = await find();
  for (let i = 0; day === undefined && i < 2 && (await page.locator("#next").isEnabled()); i++) {
    await page.click("#next");
    day = await find();
  }
  return day;
}

/** Saves a screenshot when SHOTS_DIR is set (for the PR). */
export async function shot(page, name) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), await page.screenshot());
}

/** Taps the consent row where a thumb would: on the check circle (the whole row is the checkbox's hit area: the label, plus the
 *  invisible native input stretched over it, which sits above or below the circle's icon depending on its animation state). */
export async function toggleConsent(page) {
  await page.locator("#f-consent").click({ position: { x: 14, y: 14 } });
}

/** Fills the contact step. */
export async function fillContact(page, { name = "Марина", surname = "Коваленко", phone = "501234567" } = {}) {
  await page.fill("#name", name);
  await page.fill("#surname", surname);
  await page.fill("#phone", "");
  await page.type("#phone", phone);
  await toggleConsent(page);
}

export const SVC_ID = {
  classic: "11111111-1111-4111-8111-111111111111",
  gel: "22222222-2222-4222-8222-222222222222",
  pedi: "33333333-3333-4333-8333-333333333333",
  brows: "44444444-4444-4444-8444-444444444444",
};

/** Drives the flow up to (and including) the chosen step, returning the picked day. */
export async function driveTo(page, step, { services = [SVC_ID.classic], slotIndex = 2, contact = {}, code = "123456" } = {}) {
  await page.click("#book-cta");
  for (const id of services) await page.click(`#svc-list [data-id="${id}"]`);
  if (step === "services") return;
  await page.click("#cta-services");
  const day = await pickableDay(page);
  await page.click(`[data-day="${day}"]`);
  if (step === "date") return day;
  await page.click("#cta-date");
  await page.waitForSelector("#slots .slot");
  await page.locator("#slots .slot").nth(slotIndex).click();
  if (step === "time") return day;
  await page.click("#cta-time");
  await fillContact(page, contact);
  if (step === "contact") return day;
  await page.click("#cta-contact");
  await page.waitForSelector("#otp", { state: "visible" });
  if (code) await page.locator("#otp input").fill(code);
  if (step === "otp") return day;
  await page.click("#cta-otp");
  await page.waitForSelector("#confirm-card", { state: "visible" });
  return day;
}
