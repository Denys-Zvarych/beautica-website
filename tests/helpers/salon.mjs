// Helpers for the salon wizard specs (tests/book-salon-wizard.test.mjs, tests/book-axe.test.mjs): drive /book/s/wiz-* through the steps.
import assert from "node:assert/strict";
import { bookPage, fillContact } from "./book.mjs";
import { WIZ } from "./mock-api.mjs";

export const [M1, M2, M3] = WIZ.masters;
export const [S1, S2, S3, S4] = WIZ.services;
export async function salonPage(browser, slug, opts = {}) {
  return bookPage(browser, slug, { path: `/book/s/${slug}`, init: () => {
    window.__icsBlobs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => (window.__icsBlobs.push(b), create(b));
  }, ...opts });
}
export const openAll = (page, sel) => page.evaluate((q) => document.querySelectorAll(`${q} details`).forEach((d) => (d.open = true)), sel);
export const pickServices = async (page, ...svcs) => {
  await page.click("#book-cta");
  await page.waitForSelector("[data-screen=services]:not([hidden])");
  await openAll(page, "#svc-list"); // only the first category starts open (as the app)
  for (const s of svcs) await page.click(`#svc-list [data-id="${s.id}"]`);
};
export const toggleMaster = (page, m) => page.locator(`#master-list input[data-master="${m.id}"]`).click();
export const chip = (page, s, m) => page.locator(`[data-chip="${s.id}|${m.id}"]`);

/** Clicks and waits for the bookable-days answer of the master page that opens (the calendar greys days out once it lands). */
export async function clickAndLoadDays(page, selector) {
  const answered = page.waitForResponse((r) => r.url().includes("/bookable-days"));
  await page.click(selector);
  await answered;
  await page.waitForTimeout(150);
}
/** To the next master's date page: their days were prefetched while the previous page was open, so no new request is awaited. */
export async function nextMaster(page) {
  await page.click("#cta-time");
  await page.waitForSelector("[data-screen=date]:not([hidden])");
  await page.waitForTimeout(150);
}
/** In-window future days of the open month with their state, optionally for given weekdays (0 = Sunday). */
export const days = (page, dows) =>
  page.evaluate((w) => {
    const today = document.querySelector(".dbtn.today")?.dataset.day;
    return [...document.querySelectorAll(".dbtn")]
      .map((b) => ({ day: b.dataset.day, ok: b.classList.contains("ok"), disabled: b.disabled }))
      .filter((d) => d.day > today && w.includes(new Date(`${d.day}T12:00:00Z`).getUTCDay()));
  }, dows);
/** Picks the first workable Tue-Fri day. */
export async function pickDay(page) {
  const d = (await days(page, [2, 3, 4, 5])).find((x) => x.ok);
  assert.ok(d, "a workable day exists in the open month");
  await page.click(`[data-day="${d.day}"]`);
  return d.day;
}
export async function pickSlot(page, index = 1) {
  await page.waitForSelector("#slots .slot");
  await page.locator("#slots .slot").nth(index).click();
}
/** Date -> time for the master page that is open; returns the chosen day. */
export async function scheduleMaster(page, index = 1) {
  const day = await pickDay(page);
  await page.click("#cta-date");
  await pickSlot(page, index);
  return day;
}
export async function verifyOtp(page, phone) {
  await fillContact(page, { phone });
  await page.click("#cta-contact");
  await page.waitForSelector("#otp", { state: "visible" });
  await page.locator("#otp input").fill("123456");
  await page.waitForSelector("#salon-cards", { state: "visible" });
}
/** Gel (M1 only) + brows with M2 picked: two masters, one appointment each. Stops on the confirm step. */
export async function toConfirm(page, phone) {
  await pickServices(page, S2, S3);
  await page.click("#cta-services");
  await toggleMaster(page, M1);
  await toggleMaster(page, M2);
  await clickAndLoadDays(page, "#cta-masters");
  const d1 = await scheduleMaster(page, 1);
  await nextMaster(page);
  const d2 = await scheduleMaster(page, 2);
  await page.click("#cta-time");
  await verifyOtp(page, phone);
  return { d1, d2 };
}

