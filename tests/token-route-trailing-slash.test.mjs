// A trailing slash on a token route must behave the same for an HTTP client and for a browser navigation: redirect (307, no-store) to the
// slash-less URL, which serves the shell. Before the explicit rules in public/_redirects a browser got the 404 page.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open } from "./helpers/browser.mjs";
import { BASE, TOKEN, rawRequest, requireBase, uk } from "./helpers/env.mjs";
import { tokenFromPath } from "../src/lib/guestCancel.ts";

requireBase();

const SHAPES = [
  // The cancel page has one h1 that follows its state (loading, then the state shown): any of its headings proves the page rendered.
  { path: `/book/cancel/${TOKEN}`, h1: ["Скасування запису", uk.cancel.confirmTitle, uk.cancel.doneTitle, uk.cancel.closedTitle, uk.cancel.notfoundTitle, uk.cancel.errorTitle] },
  { path: `/bookings/${TOKEN}`, h1: "Ваш запис у Beautica" },
  { path: `/bookings/${TOKEN}/review`, h1: "Залиште відгук" },
  { path: "/invite/accept?token=abc123", h1: "Вас запросили до Beautica" },
];
const withSlash = (p) => (p.includes("?") ? p.replace("?", "/?") : p + "/");

describe("trailing slash on token routes", () => {
  let browser;
  before(async () => (browser = await launch()));
  after(async () => browser?.close());

  for (const { path, h1 } of SHAPES) {
    test(`${withSlash(path)} redirects to ${path} for an HTTP client and a browser`, async () => {
      const raw = await rawRequest(withSlash(path), { headers: { accept: "text/html" } });
      assert.equal(raw.status, 307);
      assert.deepEqual(raw.all("cache-control"), ["no-store"]);
      assert.deepEqual(raw.all("referrer-policy"), ["no-referrer"]);
      assert.deepEqual(raw.all("x-robots-tag"), ["noindex, nofollow"]);
      assert.equal(new URL(raw.headers.location, BASE).pathname + new URL(raw.headers.location, BASE).search, path);

      const { page, context } = await open(browser);
      try {
        const res = await page.goto(BASE + withSlash(path));
        assert.equal(res.status(), 200, "a browser navigation must not hit the 404 page");
        assert.equal(page.url(), BASE + path, "the address bar ends on the slash-less URL (query kept)");
        assert.equal(await page.locator("h1").count(), 1, "one h1");
        const got = (await page.locator("h1").innerText()).trim();
        assert.ok([h1].flat().includes(got), `h1 «${got}»`);
      } finally {
        await context.close();
      }
    });
  }

  test("the guest-cancel path parser accepts both forms", () => {
    assert.equal(tokenFromPath(`/book/cancel/${TOKEN}`), TOKEN);
    assert.equal(tokenFromPath(`/book/cancel/${TOKEN}/`), TOKEN);
    assert.equal(tokenFromPath(`/book/cancel/${TOKEN}/x`), null);
  });
});
