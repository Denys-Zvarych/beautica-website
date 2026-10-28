// axe-core sweep of the link pages: every tab of the master and salon pages and every booking step (360 px; AXE_WIDTHS=768,1280 for the others).
// WCAG 2 A/AA + best-practice rules; zero violations expected (the 11 px design text is allowed: no rule covers it).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { launch } from "./helpers/browser.mjs";
import { bookPage, pickableDay, fillContact, driveTo, SVC_ID } from "./helpers/book.mjs";
import { requireBase } from "./helpers/env.mjs";
import { M1, M2, S1, S2, S3, salonPage, pickServices, toggleMaster, chip, clickAndLoadDays, nextMaster, scheduleMaster, verifyOtp, pickDay, pickSlot } from "./helpers/salon.mjs";

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
  for (const width of WIDTHS) test(`booking steps @${width} (services, date, time, contact with errors, code, confirm, done)`, async () => {
    const env = await bookPage(browser, "oksana-ab12", { width });
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
      await page.locator("#otp input").fill("123456");
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

describe("axe: the salon wizard (phase 016/017)", () => {
  for (const width of WIDTHS) {
    test(`salon services-tab filter (chip shown) @${width}`, async () => {
      const env = await salonPage(browser, `wiz-axe-f${width}`, { width });
      try {
        const { page } = env;
        await page.waitForSelector("[role=tablist]");
        await page.getByRole("tab", { name: "Послуги" }).click();
        await sweep(page, `salon services tab with filterable tiles @${width}`);
        await page.locator(`[data-filter-id="${S1.id}"]`).click();
        await sweep(page, `salon masters tab with the filter chip @${width}`);
      } finally {
        await env.context.close();
      }
    });
    test(`salon wizard steps @${width} (services, masters + chips, per-master date and time, confirm cards, done)`, async () => {
      const env = await salonPage(browser, `wiz-axe-w${width}`, { width });
      try {
        const { page } = env;
        await pickServices(page, S1, S2, S3);
        await sweep(page, "salon services");
        await page.click("#cta-services");
        await toggleMaster(page, M1);
        await toggleMaster(page, M2);
        await sweep(page, "salon masters, unresolved service (chips)");
        await chip(page, S1, M1).click();
        await clickAndLoadDays(page, "#cta-masters");
        await sweep(page, "salon date with the master pager");
        await scheduleMaster(page, 1);
        await sweep(page, "salon time");
        await nextMaster(page);
        await scheduleMaster(page, 1);
        await page.click("#cta-time");
        await verifyOtp(page, "501130001");
        await sweep(page, "salon confirm cards");
        await page.click("#cta-confirm");
        await page.waitForSelector("#done-list [data-done]", { state: "visible" });
        await sweep(page, "salon done", 1300);
      } finally {
        await env.context.close();
      }
    });
  }
});

// Touch targets of the contact and code steps (WCAG 2.5.8 / the project's 48 px rule). A pseudo-element hit area has no bounding box, so the
// effective area is measured the way a finger finds it: probe the points around the control and keep those that resolve to it (or its label).
const HIT = 47.99;
/** Width x height of the area around `sel` (an element or each match) that resolves to `sel` or to its closest <label>. */
const hitAreas = (page, sel) =>
  page.evaluate((q) => {
    return [...document.querySelectorAll(q)].map((el) => {
      const own = el.closest("label") ?? el;
      const r = (el.closest("label") ?? el).getBoundingClientRect();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let x = Math.floor(r.left) - 14; x <= Math.ceil(r.right) + 14; x++)
        for (let y = Math.floor(r.top) - 14; y <= Math.ceil(r.bottom) + 14; y++) {
          const hit = document.elementFromPoint(x, y);
          if (hit && (hit === own || own.contains(hit))) (x0 = Math.min(x0, x)), (x1 = Math.max(x1, x + 1)), (y0 = Math.min(y0, y)), (y1 = Math.max(y1, y + 1));
        }
      return [x1 - x0, y1 - y0];
    });
  }, sel);
describe("touch targets: consent row and code cells are at least 48 x 48 px (effective hit area)", () => {
  for (const width of WIDTHS) {
    test(`contact step (master link) @${width}: the consent row, the fields and the buttons`, async () => {
      const env = await bookPage(browser, "oksana-ab12", { width, height: 900 });
      try {
        const { page } = env;
        await driveTo(page, "contact");
        for (const sel of ["#f-consent", "#cta-contact", "#f-name .box", "#f-surname .box", "#f-phone .box"]) {
          const b = await page.locator(sel).boundingBox();
          assert.ok(b && b.height >= HIT && b.width >= HIT, `${sel} is ${b?.width}x${b?.height} at ${width}px`);
        }
      } finally {
        await env.context.close();
      }
    });
    test(`contact step (salon wizard) @${width}: the consent row`, async () => {
      const env = await salonPage(browser, `wiz-hit-c${width}`, { width, height: 900 });
      try {
        const { page } = env;
        await pickServices(page, S2);
        await page.click("#cta-services");
        await toggleMaster(page, M1);
        await clickAndLoadDays(page, "#cta-masters");
        await pickDay(page).then(() => page.click("#cta-date"));
        await pickSlot(page, 1);
        await page.click("#cta-time");
        const b = await page.locator("#f-consent").boundingBox();
        assert.ok(b && b.height >= HIT, `#f-consent is ${b?.height}px tall at ${width}px`);
      } finally {
        await env.context.close();
      }
    });
    test(`code step @${width}: the code input's hit area (the label's extension included) and the resend button`, async () => {
      const env = await bookPage(browser, "oksana-ab12", { width, height: 900 });
      try {
        const { page } = env;
        await driveTo(page, "otp", { code: "" });
        const cells = await hitAreas(page, "#otp input");
        assert.equal(cells.length, 1);
        for (const [w, h] of cells) assert.ok(w >= HIT && h >= HIT, `an OTP cell's hit area is ${w}x${h} at ${width}px`);
        const b = await page.locator("#cta-otp").boundingBox();
        assert.ok(b.height >= HIT);
      } finally {
        await env.context.close();
      }
    });
  }
});

describe("axe: the «Можливо, ви вже записані» notice (a marker is stored)", () => {
  for (const [kind, path, slug] of [["master", "/book/oksana-ab12", "oksana-ab12"], ["salon", "/book/s/lavanda-1111", "lavanda-1111"]])
    for (const width of WIDTHS)
      test(`${kind} page with the notice @${width}`, async () => {
        const init = `try { sessionStorage.setItem("bk-unsure:${kind}:${slug}", JSON.stringify({ slotStartIso: "2030-01-02T10:00:00+02:00", label: "вівторок, 2 січня, 10:00", at: Date.now() - 1000 })); } catch {}`;
        const env = await bookPage(browser, null, { path, width, init });
        try {
          await env.page.locator("#unsure-note").waitFor();
          await sweep(env.page, `${kind} with the notice @${width}`);
          await env.page.getByRole("button", { name: "Зрозуміло" }).click();
          await sweep(env.page, `${kind} after dismissing the notice @${width}`);
        } finally {
          await env.context.close();
        }
      });
});

describe("axe: the guest review page /r/{token} (every state)", () => {
  const tok = (kind, n) => `${kind}-test-${String(n).padStart(8, "0")}`;
  const rv = (token, width) => bookPage(browser, token, { path: `/r/${token}`, clock: false, width });
  for (const width of WIDTHS) {
    for (const [name, token] of [["already", tok("rvdone", 31)], ["invalid", tok("zznone", 31)]])
      test(`${name} @${width}`, async () => {
        const env = await rv(token, width);
        try {
          assert.equal(await env.page.locator("h1:visible").count(), 1, "one visible h1");
          await sweep(env.page, `/r ${name} @${width}`);
        } finally {
          await env.context.close();
        }
      });
    test(`form, 429 notice, opt-out confirm, success @${width}`, async () => {
      const env = await rv(tok("rvslow", 31), width);
      try {
        const { page } = env;
        await sweep(page, `/r form @${width}`);
        await page.locator(".starbtn[data-v='5']").first().click();
        await page.click("#rv-submit");
        await page.waitForSelector("#rv-error", { state: "visible" });
        await sweep(page, `/r 429 notice @${width}`);
        await page.click("#rv-optout");
        await page.waitForSelector("[data-screen=optout-confirm]:not([hidden])");
        await sweep(page, `/r opt-out confirm @${width}`);
      } finally {
        await env.context.close();
      }
      const ok = await rv(tok("rvopen", 31), width);
      try {
        await ok.page.locator(".starbtn[data-v='5']").first().click();
        await ok.page.click("#rv-submit");
        await ok.page.waitForSelector("[data-screen=success]:not([hidden])");
        await sweep(ok.page, `/r success @${width}`);
      } finally {
        await ok.context.close();
      }
    });
  }
});
