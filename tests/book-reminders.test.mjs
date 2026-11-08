// Phase 022 (browser, mock backend): the success screen's reminder choice. The done step is also the CLS probe for it: showing the block
// (and swapping it to the static "unavailable" line after a late 404) must not shift the page (<= 0.005, the Lighthouse budget).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";
import { SHORT_TOKEN } from "./helpers/env.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

// Like Chrome / Lighthouse: shifts right after a user input (hadRecentInput) are exempt, so the click that switches SMS | Telegram is not counted.
const CLS = `window.__cls=0;new PerformanceObserver(function(l){for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value}).observe({type:"layout-shift",buffered:true});`;
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
const jsonRoute = (page, name, status, body) => page.route(`**/api/v1/book/telegram/${name}`, (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }));

async function toDone(env) {
  await driveTo(env.page, "confirm");
  await env.page.click("#cta-confirm");
  await env.page.waitForSelector("#done-card", { state: "visible" });
  // Real content below the block (the footer line of the screen sits too far down to be in view): a block that grows or shrinks later shifts it.
  await env.page.evaluate(() => {
    const probe = document.createElement("p");
    probe.textContent = "probe below the reminders block";
    probe.style.cssText = "margin:0;padding:8px 0";
    document.getElementById("done-reminders").after(probe);
    window.__cls0 = window.__cls;
  });
  await env.page.evaluate(() => (window.__cls0 = window.__cls)); // shifts of the earlier steps do not count: only what the done screen itself adds
}
const shift = (page) => page.evaluate(() => window.__cls - window.__cls0);

describe("done screen, Telegram on", () => {
  test("the block shows SMS preselected; selecting Telegram only reveals the connect button (no request); no layout shift", async () => {
    const env = await bookPage(browser, "tgdone-3131", { init: CLS });
    try {
      const calls = [];
      await env.page.route("**/api/v1/book/telegram/**", (r) => (calls.push(r.request().url()), r.fulfill({ status: 404, body: "{}" })));
      await toDone(env);
      const block = env.page.locator("#done-reminders");
      await block.waitFor({ state: "visible" });
      assert.equal(await env.page.locator("#done-reminders .seg").getAttribute("role"), "group", "native radios in a segmented group");
      assert.equal(await env.page.locator("#done-reminders .seg input[type=radio][name=reminder-channel]").count(), 2);
      assert.equal(await env.page.getByRole("group", { name: "Куди надсилати нагадування про записи?" }).count(), 1, "group labelled by the heading");
      assert.equal(await env.page.locator('#done-reminders input[value=sms]').isChecked(), true);
      const box = await env.page.locator('#done-reminders input[value=telegram]').locator("xpath=..").boundingBox();
      assert.ok(box && box.height >= 47.99, `segment is a 48 px target (subpixel layout, same tolerance as book-axe HIT): ${box?.height}`);
      const desc = env.page.locator("#reminders-desc");
      assert.equal((await desc.locator("[data-r-desc=sms]:not([data-off])").innerText()).trim(), "Нагадування прийдуть в SMS на номер, який ви вказали.");
      assert.equal(await env.page.locator("[data-r-connect]").isVisible(), false, "Connect only for Telegram");
      await env.page.locator('#done-reminders input[value=sms]').focus();
      await env.page.keyboard.press("ArrowDown");
      assert.equal(await env.page.locator('#done-reminders input[value=telegram]').isChecked(), true);
      await env.page.locator("[data-r-connect]").waitFor({ state: "visible" });
      const tgText = (await desc.locator("[data-r-desc=telegram]:not([data-off])").innerText()).trim();
      assert.equal(tgText, "Відкриється бот Beautica: «Почати» → «Поділитися номером».");
      assert.equal(await desc.innerText().then((x) => x.includes("Код і підтвердження")), false, "dropped sentence stays dropped");
      assert.deepEqual(calls, [], "arrow-key selection sends nothing");
      await settle(env.page);
      const cls = await shift(env.page);
      console.log("done-step CLS (block + connect button):", cls);
      assert.ok(cls <= 0.005, `CLS ${cls}`);
      assert.deepEqual(env.problems, []);
    } finally {
      await env.context.close();
    }
  });
  test("a 404 on the connect call keeps the block (same height) with the static unavailable line; CLS stays <= 0.005", async () => {
    const env = await bookPage(browser, "tgdone-3131", { init: CLS });
    try {
      await jsonRoute(env.page, "link-token", 404, { success: false });
      await toDone(env);
      await env.page.locator("#done-reminders").waitFor({ state: "visible" });
      await settle(env.page);
      const before = await env.page.evaluate(() => ({ cls: window.__cls - window.__cls0, h: document.getElementById("done-reminders").getBoundingClientRect().height }));
      await env.page.locator('#done-reminders input[value=telegram]').check({ force: true });
      await env.page.click("[data-r-connect]");
      await env.page.locator("[data-r-unavailable]").waitFor({ state: "visible" });
      await settle(env.page);
      const after = await env.page.evaluate(() => ({ cls: window.__cls - window.__cls0, h: document.getElementById("done-reminders").getBoundingClientRect().height }));
      assert.ok(after.h >= before.h - 1, `block height ${before.h} -> ${after.h}`);
      assert.ok(after.cls <= 0.005, `CLS ${after.cls}`);
    } finally {
      await env.context.close();
    }
  });
  test("two quick taps on the connect button send one link-token", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      let n = 0;
      await env.page.route("**/api/v1/book/telegram/link-token", async (r) => (n++, await new Promise((x) => setTimeout(x, 300)), r.fulfill({ status: 404, body: "{}" })));
      await toDone(env);
      await env.page.locator('#done-reminders input[value=telegram]').check({ force: true });
      await env.page.locator("[data-r-connect]").dblclick();
      await env.page.locator("[data-r-unavailable]").waitFor({ state: "visible" });
      assert.equal(n, 1);
    } finally {
      await env.context.close();
    }
  });
});

// Contract probe (real DOM, routed Telegram endpoints; the t.me origin is stubbed, nothing leaves the machine).
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" };
const OK_URL = "https://t.me/beautica_app_bot?start=abc_DEF-123";
/** Routes `telegram/<name>` (records POST bodies in `calls[name]`; answers preflights). `reply` is a body or (n) => [status, body]. */
async function tgRoutes(page, replies) {
  const calls = { "link-token": [], status: [], unlink: [] };
  await page.route("**/api/v1/book/telegram/*", async (r) => {
    const req = r.request();
    if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
    const name = new URL(req.url()).pathname.split("/").pop();
    calls[name].push(req.postData());
    const [status, body] = replies[name]?.(calls[name].length) ?? [404, {}];
    return r.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: status === 204 ? "" : JSON.stringify(body) });
  });
  return calls;
}
/** The booking answer carries this `telegram` block. */
const bookingWith = (page, telegram) =>
  page.route("**/api/v1/book/tgdone-3131/booking", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    const res = await r.fetch();
    const j = await res.json();
    await r.fulfill({ response: res, json: { ...j, telegram } });
  });
const stubTme = (page) => page.context().route("https://t.me/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>tme</title>" }));
const pickTelegram = async (page) => {
  await page.locator('#done-reminders input[value=sms]').focus();
  await page.keyboard.press("ArrowDown");
  await page.locator("[data-r-connect]").click({ noWaitAfter: true });
};
const visibleAgain = (page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

describe("done screen, Telegram contract", () => {
  test("short cancel link: cancelUrl https://beautica.app/c/{16} gives the Telegram link-token its 16-char token, no cancel link on the screen", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      const calls = await tgRoutes(env.page, { "link-token": () => [200, { url: OK_URL, expiresAt: "2026-11-02T10:30:00Z", alreadyLinked: false }] });
      await stubTme(env.page);
      await env.page.route("**/api/v1/book/tgdone-3131/booking", async (r) => {
        if (r.request().method() !== "POST") return r.fallback();
        const res = await r.fetch();
        await r.fulfill({ response: res, json: { ...(await res.json()), cancelUrl: `https://beautica.app/c/${SHORT_TOKEN}`, telegram: { available: true, linked: false } } });
      });
      await toDone(env);
      assert.equal(await env.page.locator("[data-screen=done] a[href*='/c/'], [data-screen=done] a[href*='/book/cancel']").count(), 0, "the done screen links no cancel page");
      await pickTelegram(env.page);
      await env.page.waitForURL(OK_URL);
      assert.deepEqual(calls["link-token"].map((b) => JSON.parse(b)), [{ cancelToken: SHORT_TOKEN }], "the short token, unchanged, in the body only");
    } finally {
      await env.context.close();
    }
  });

  test("Telegram click: link-token body is {cancelToken} only, the browser goes to the returned t.me url", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      const calls = await tgRoutes(env.page, { "link-token": () => [200, { url: OK_URL, expiresAt: "2026-11-02T10:30:00Z", alreadyLinked: false }] });
      await stubTme(env.page);
      await toDone(env);
      await pickTelegram(env.page);
      await env.page.waitForURL(OK_URL);
      assert.equal(calls["link-token"].length, 1);
      assert.deepEqual(JSON.parse(calls["link-token"][0]), { cancelToken: "123e4567-e89b-42d3-a456-426614174000" });
    } finally {
      await env.context.close();
    }
  });
  test("a foreign url from the backend is not followed: error shown, SMS re-selected", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      await tgRoutes(env.page, { "link-token": () => [200, { url: "https://evil.example/x?start=a", expiresAt: null, alreadyLinked: false }] });
      let evil = 0;
      await env.page.context().route("https://evil.example/**", (r) => (evil++, r.abort()));
      await toDone(env);
      const doneUrl = env.page.url(); // phase 032: the done step already switched the address to the cancel URL
      await pickTelegram(env.page);
      await env.page.getByText("Не вдалося підключити Telegram. Нагадування надходитимуть SMS.").waitFor({ state: "visible" });
      assert.equal(evil, 0);
      assert.equal(env.page.url(), doneUrl, "the Telegram tap must not navigate anywhere");
      assert.equal(await env.page.locator('#done-reminders input[value=sms]').isChecked(), true);
    } finally {
      await env.context.close();
    }
  });
  test("429 on link-token shows the rate-limit copy, stays on the page", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      await tgRoutes(env.page, { "link-token": () => [429, { success: false }] });
      await toDone(env);
      const doneUrl = env.page.url(); // phase 032: the done step already switched the address to the cancel URL
      await pickTelegram(env.page);
      await env.page.getByText("Забагато спроб, спробуйте за кілька хвилин").waitFor({ state: "visible" });
      assert.equal(env.page.url(), doneUrl, "the Telegram tap must not navigate anywhere");
    } finally {
      await env.context.close();
    }
  });
  test("available:false in the booking answer: no block, no Telegram request", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      const calls = await tgRoutes(env.page, {});
      await bookingWith(env.page, { available: false, linked: false });
      await toDone(env);
      await settle(env.page);
      assert.equal(await env.page.locator("#done-reminders").isVisible(), false);
      assert.deepEqual(calls, { "link-token": [], status: [], unlink: [] });
    } finally {
      await env.context.close();
    }
  });
  test("SMS selection (click) sends no request", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      const calls = await tgRoutes(env.page, {});
      await toDone(env);
      await env.page.locator('#done-reminders input[value=telegram]').check({ force: true });
      await env.page.locator('#done-reminders input[value=sms]').check({ force: true });
      await env.page.waitForFunction(() => document.querySelector("[data-r-connect]").hidden);
      assert.deepEqual(calls, { "link-token": [], status: [], unlink: [] });
    } finally {
      await env.context.close();
    }
  });
  test("linked:true shows the status line and the unlink button; unlink posts {cancelToken} and returns to the choice with SMS checked", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      const calls = await tgRoutes(env.page, { unlink: () => [204, null] });
      await bookingWith(env.page, { available: true, linked: true });
      await toDone(env);
      await env.page.getByText("Нагадування надходять у Telegram").waitFor({ state: "visible" });
      assert.equal(await env.page.locator('#done-reminders input[value=sms]').isVisible(), false);
      await env.page.getByRole("button", { name: "Відписатися від Telegram" }).click();
      await env.page.locator('#done-reminders input[value=sms]').waitFor({ state: "visible" });
      assert.equal(await env.page.locator('#done-reminders input[value=sms]').isChecked(), true);
      assert.deepEqual(calls.unlink.map((b) => JSON.parse(b)), [{ cancelToken: "123e4567-e89b-42d3-a456-426614174000" }]);
    } finally {
      await env.context.close();
    }
  });
  test("coming back from Telegram: ONE status call, then the linked state", async () => {
    const env = await bookPage(browser, "tgdone-3131");
    try {
      const calls = await tgRoutes(env.page, {
        "link-token": () => [200, { url: OK_URL, expiresAt: "x", alreadyLinked: false }],
        status: () => [200, { available: true, linked: true, offerChoice: false }],
      });
      await env.page.context().route("https://t.me/**", (r) => r.fulfill({ status: 204 })); // 204 = the browser stays on the page, as if the tab were backgrounded
      await toDone(env);
      // The deterministic signal that the handler is awaiting the return: it asks the browser to go to t.me (`awaitingReturn = true` is set synchronously just before).
      // The button is disabled EARLIER (while link-token is in flight), so waiting on `disabled` let the visibility event arrive too soon and be ignored.
      const toTme = env.page.waitForRequest((r) => r.url().startsWith("https://t.me/"));
      await pickTelegram(env.page);
      await toTme;
      const statusDone = env.page.waitForResponse((r) => r.url().endsWith("/api/v1/book/telegram/status"));
      await visibleAgain(env.page);
      await statusDone;
      // waitForFunction, not a locator wait: Playwright's own waits block on the pending (204) navigation.
      await env.page.waitForFunction(() => !document.querySelector("[data-r-linked]").hidden);
      await visibleAgain(env.page);
      await settle(env.page);
      assert.equal(calls.status.length, 1);
      assert.deepEqual(JSON.parse(calls.status[0]), { cancelToken: "123e4567-e89b-42d3-a456-426614174000" });
    } finally {
      await env.context.close();
    }
  });
});

describe("done screen, Telegram off", () => {
  test("a booking without telegram.available: no block, no Telegram request", async () => {
    const env = await bookPage(browser, "oksana-ab12");
    try {
      const calls = [];
      await env.page.route("**/api/v1/book/telegram/**", (r) => (calls.push(r.request().url()), r.fulfill({ status: 404, body: "{}" })));
      await toDone(env);
      assert.equal(await env.page.locator("#done-reminders").isVisible(), false);
      assert.deepEqual(calls, []);
    } finally {
      await env.context.close();
    }
  });
});
