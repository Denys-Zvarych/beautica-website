// The master «Про майстра» tab is already named by its tab: with a bio the panel must not repeat it as a visible heading.
// An sr-only heading stays (panel outline); the empty state keeps its visible heading.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage } from "./helpers/book.mjs";
import { requireBase } from "./helpers/env.mjs";

requireBase();
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

// Headings of panel 0 named «Про майстра» whose box is a real, visible one (sr-only is a 1x1 clipped box).
const visibleAboutHeadings = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#panel-0 h1, #panel-0 h2, #panel-0 h3")]
      .filter((h) => h.textContent.trim() === "Про майстра")
      .filter((h) => {
        const r = h.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      })
      .map((h) => h.className),
  );

describe("master about tab", () => {
  test("with a bio: bio shown, no visible «Про майстра» heading, panel keeps an sr-only one", async () => {
    const env = await bookPage(browser, "oksana-ab12", { width: 360 });
    try {
      const { page } = env;
      assert.match(await page.locator("#panel-0 .bio").innerText(), /Роблю манікюр/);
      assert.deepEqual(await visibleAboutHeadings(page), []);
      assert.equal(await page.locator("#panel-0 h2.sr-only", { hasText: "Про майстра" }).count(), 1);
    } finally {
      await env.context.close();
    }
  });

  test("without a bio: the empty state keeps its heading and note", async () => {
    const env = await bookPage(browser, "sparse-0001", { width: 360 });
    try {
      const { page } = env;
      assert.equal((await visibleAboutHeadings(page)).length, 1);
      assert.match(await page.locator("#panel-0").innerText(), /Опис майстра поки не додано/);
    } finally {
      await env.context.close();
    }
  });
});
