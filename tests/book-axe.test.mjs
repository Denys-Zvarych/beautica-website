// axe-core sweep of the link pages: every tab of the master and salon pages and every booking step (360 px; AXE_WIDTHS=768,1280 for the others).
// WCAG 2 A/AA + best-practice rules; zero violations expected (the 11 px design text is allowed: no rule covers it).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { launch } from "./helpers/browser.mjs";
import { bookPage, pickableDay, fillContact, SVC_ID } from "./helpers/book.mjs";
import { requireBase } from "./helpers/env.mjs";

requireBase();
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
// axe is slow on a small VM: one width per run by default; AXE_WIDTHS=768 / 1280 (or a list) for the others.
const WIDTHS = (process.env.AXE_WIDTHS ?? "360").split(",").map(Number);
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

async function sweep(page, label, settle = 350) {
  await page.waitForTimeout(settle); // animations settle (axe reads the live colours)
  await page.evaluate(AXE);
  const r = await page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }));
  assert.deepEqual(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`), [], label);
}

describe("axe: master and salon pages, every tab", () => {
  for (const width of WIDTHS) {
    test(`master tabs @${width}`, async () => {
      const env = await bookPage(browser, "oksana-ab12", { width });
      try {
        await env.page.waitForSelector("[role=tablist]");
        for (const tab of ["Про майстра", "Послуги", "Відгуки"]) {
          await env.page.getByRole("tab", { name: tab }).click();
          await sweep(env.page, `master ${tab} @${width}`);
        }
        await env.page.locator("[data-sortmenu] summary").click();
        await sweep(env.page, `master sort menu open @${width}`);
      } finally {
        await env.context.close();
      }
    });
    test(`salon tabs @${width}`, async () => {
      const env = await bookPage(browser, null, { path: "/book/s/lavanda-1111", width });
      try {
        await env.page.waitForSelector("[role=tablist]");
        for (const tab of ["Про салон", "Майстри", "Послуги", "Відгуки"]) {
          await env.page.getByRole("tab", { name: tab }).click();
          await sweep(env.page, `salon ${tab} @${width}`);
        }
      } finally {
        await env.context.close();
      }
    });
    test(`no-photo master and the notice pages @${width}`, async () => {
      for (const [path, js] of [["/book/sparse-0001", true], ["/book/closed-aaaa", true], ["/book/nobody-0000", true]]) {
        const env = await bookPage(browser, null, { path, width, js });
        try {
          await sweep(env.page, `${path} @${width}`);
        } finally {
          await env.context.close();
        }
      }
    });
  }
  test(WIDTHS.includes(360) ? "booking steps @360 (services, date, time, contact with errors, code, confirm, done)" : "booking steps (360 only: skipped)", { skip: !WIDTHS.includes(360) }, async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const { page } = env;
      await page.click("#book-cta");
      await sweep(page, "services");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      await sweep(page, "date");
      await page.click(`[data-day="${await pickableDay(page)}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      await page.locator("#slots .slot").nth(2).click();
      await sweep(page, "time");
      await page.click("#cta-time");
      await page.click("#cta-contact");
      await sweep(page, "contact with errors");
      await fillContact(page);
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await sweep(page, "code");
      for (const [i, d] of [..."123456"].entries()) await page.locator("#otp input").nth(i).fill(d);
      await page.click("#cta-otp");
      await page.waitForSelector("#confirm-card", { state: "visible" });
      await page.fill("#comment", "Коментар");
      await sweep(page, "confirm");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      await sweep(page, "done", 1300); // the success step fades in
    } finally {
      await env.context.close();
    }
  });
});
