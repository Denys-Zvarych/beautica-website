// Phase 036 (browser, mock backend): the copy hint on service tiles. A master / salon with two services of ONE name (60 + 90 min):
// both tiles carry « · {duration}» on the profile, in the /book/{slug} picker and on the salon page; both can be selected and the totals sum;
// pages with no duplicate names render no hint at all (acceptance 3).
// After selection the hinted name follows into the picker summary (.sel-entry), the confirm recap and the salon plan (data-display).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";
import { DUP_SVC } from "./helpers/mock-api.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const [A, B, UNIQUE] = DUP_SVC;
const HINT_60 = "Класичний масаж · 1 год";
const HINT_90 = "Класичний масаж · 1 год 30 хв";
const squash = (s) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
const names = async (loc) => (await loc.evaluateAll((els) => els.map((e) => e.textContent))).map(squash);

async function withPage(slug, opts, fn) {
  const env = await bookPage(browser, slug, opts);
  try {
    await fn(env);
    assert.deepEqual(env.problems, [], "no console / page errors");
  } finally {
    await env.context.close();
  }
}

for (const width of [360, 1280]) {
  describe(`master with two same-name copies @${width}`, () => {
    test("profile: both copies show their duration hint, the unique service shows none", async () => {
      await withPage("dupcopy-0361", { width }, async ({ page }) => {
        const tiles = page.locator(".stile.ro .name");
        const all = await names(tiles);
        assert.ok(all.includes(HINT_60) && all.includes(HINT_90), `both hinted: ${all}`);
        assert.ok(all.includes(UNIQUE.name), "the unique service keeps its bare name");
        assert.equal(all.filter((n) => n.includes("·")).length, 2, "only the two copies are hinted");
      });
    });

    test("/book/{slug} picker: both copies hinted, both selectable, totals sum duration and price", async () => {
      await withPage("dupcopy-0361", { width }, async ({ page }) => {
        await page.click("#book-cta");
        const list = page.locator("#svc-list");
        const a = list.locator(`[data-id="${A.id}"]`);
        const b = list.locator(`[data-id="${B.id}"]`);
        assert.equal(squash(await a.locator(".name").innerText()), HINT_60);
        assert.equal(squash(await b.locator(".name").innerText()), HINT_90);
        assert.equal(squash(await list.locator(`[data-id="${UNIQUE.id}"] .name`).innerText()), UNIQUE.name, "unique service: no hint");
        await a.click();
        await b.click();
        assert.equal(await a.getAttribute("aria-pressed"), "true");
        assert.equal(await b.getAttribute("aria-pressed"), "true");
        const sum = squash(await page.locator("[data-sb='services']").innerText());
        assert.match(sum, /2 послуги.*Разом.*2 год 30 хв.*від 1 200 ₴/, sum);
        await page.locator("[data-sb='services'] .labelrow").click();
        const sel = await names(page.locator("[data-sb='services'] .sel-entry .t-strong"));
        assert.deepEqual(sel.sort(), [HINT_60, HINT_90], `summary shows both distinct hinted names: ${sel}`);
        await b.click();
        assert.equal(await a.getAttribute("aria-pressed"), "true", "deselecting one copy leaves the other");
        assert.match(squash(await page.locator("[data-sb='services']").innerText()), /1 послуга.*Разом.*1 год.*від 500 ₴/);
      });
    });
  });
}

describe("hinted names follow the selection into confirm and the salon plan", () => {
  test("master confirm recap lists both hinted names", async () => {
    await withPage("dupcopy-0361", {}, async ({ page }) => {
      await driveTo(page, "confirm", { services: [A.id, B.id] });
      const rows = await names(page.locator("#confirm-card .recap-row .t-strong11"));
      assert.deepEqual(rows.sort(), [HINT_60, HINT_90], `confirm: ${rows}`);
    });
  });
  test("salon wizard plan (resolver + assignment list) shows both hinted names", async () => {
    await withPage("dupsalon-0362", { path: "/book/s/dupsalon-0362" }, async ({ page }) => {
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      await page.locator("#svc-list [data-id]").nth(0).click();
      await page.locator("#svc-list [data-id]").nth(1).click();
      await page.click("#cta-services");
      await page.locator("#master-list input").nth(0).click();
      await page.locator("#master-list input").nth(1).click();
      const rows = await names(page.locator("#plan .pwell .top .t-strong"));
      assert.deepEqual(rows.sort(), [HINT_60, HINT_90], `salon resolver shows both hinted names: ${rows}`);
      await page.locator("#plan .pwell").nth(0).locator(".mchip").first().click();
      await page.locator("#plan .pwell").nth(1).locator(".mchip").first().click();
      const secs = await names(page.locator("#plan .pgroup .sec"));
      const grouped = secs.flatMap((t) => t.split(", "));
      assert.deepEqual(grouped.sort(), [HINT_60, HINT_90], `salon assignment shows each hinted name once: ${secs}`);
    });
  });
});

describe("salon page", () => {
  test("services with one name show the duration hint, the unique one does not", async () => {
    await withPage("dupsalon-0362", { path: "/book/s/dupsalon-0362" }, async ({ page }) => {
      const all = await names(page.locator(".stile .name"));
      assert.ok(all.includes(HINT_60) && all.includes(HINT_90), `both hinted: ${all}`);
      assert.ok(all.includes(UNIQUE.name));
      assert.equal(all.filter((n) => n.includes("·")).length, 2);
    });
  });
});

describe("no duplicates: no hint anywhere (acceptance 3)", () => {
  test("master page + picker (oksana-ab12) render no « · » in any tile name", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.click("#book-cta");
      const all = await names(page.locator(".stile .name"));
      assert.ok(all.length >= 4, `tiles present: ${all.length}`);
      assert.deepEqual(all.filter((n) => n.includes("·")), []);
    });
  });
  test("salon page (lavanda-1111) renders no « · » in any tile name", async () => {
    await withPage("lavanda-1111", { path: "/book/s/lavanda-1111" }, async ({ page }) => {
      const all = await names(page.locator(".stile .name"));
      assert.ok(all.length >= 3);
      assert.deepEqual(all.filter((n) => n.includes("·")), []);
    });
  });
});
