// Phase 046 (browser, mock backend): the done screen says the booking was added to the guest's Beautica account only when the booking
// response has attachedToAccount === true (mock slug "attached-7171"); false / absent (any other slug) keeps the line hidden.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";
import { salonPage, toConfirm } from "./helpers/salon.mjs";
import { uk } from "./helpers/env.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

async function toDone(env) {
  await driveTo(env.page, "confirm");
  await env.page.click("#cta-confirm");
  await env.page.waitForSelector("#done-card", { state: "visible" });
}

describe("done screen: «added to your account» line", () => {
  test("attachedToAccount: true shows the uk.json copy in a non-empty box", async () => {
    const env = await bookPage(browser, "attached-7171");
    try {
      await toDone(env);
      const line = env.page.locator("#done-attached");
      await line.waitFor({ state: "visible" });
      assert.equal((await line.innerText()).trim(), uk.book.done.attached);
      assert.equal(uk.book.done.attached, "Цей запис додано до вашого акаунта в Beautica");
      const box = await line.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0);
    } finally {
      await env.context.close();
    }
  });
  test("attachedToAccount absent: the line stays hidden", async () => {
    const env = await bookPage(browser, "nocancel-8888");
    try {
      await toDone(env);
      assert.equal(await env.page.locator("#done-attached").isVisible(), false);
    } finally {
      await env.context.close();
    }
  });
  test("attachedToAccount: false and non-boolean values keep the line hidden", async () => {
    for (const value of [false, "true", 1]) {
      const env = await bookPage(browser, "attached-7171");
      try {
        await env.page.route("**/api/v1/book/attached-7171/booking", async (r) => {
          if (r.request().method() !== "POST") return r.fallback();
          const res = await r.fetch();
          await r.fulfill({ response: res, json: { ...(await res.json()), attachedToAccount: value } });
        });
        await toDone(env);
        assert.equal(await env.page.locator("#done-attached").isVisible(), false, `attachedToAccount=${JSON.stringify(value)}`);
      } finally {
        await env.context.close();
      }
    }
  });
});

// Salon wizard (/book/s/{slug}): two bookings (master 1, master 2), one POST each. The line shows when ANY of them is attached.
describe("salon done screen: «added to your account» line", () => {
  async function salonDone(slug, phone) {
    const env = await salonPage(browser, slug);
    await toConfirm(env.page, phone);
    await env.page.click("#cta-confirm");
    await env.page.waitForSelector("#done-list [data-done]", { state: "visible" });
    return env;
  }
  test("one of two bookings attached: the line shows with the uk.json copy", async () => {
    const env = await salonDone("wiz-attm2-0461", "501460001");
    try {
      const line = env.page.locator("#done-attached");
      await line.waitFor({ state: "visible" });
      assert.equal((await line.innerText()).trim(), uk.book.done.attached);
    } finally {
      await env.context.close();
    }
  });
  test("no booking attached: the line stays hidden", async () => {
    const env = await salonDone("wiz-plain-0462", "501460002");
    try {
      assert.equal(await env.page.locator("#done-attached").isVisible(), false);
    } finally {
      await env.context.close();
    }
  });
});
