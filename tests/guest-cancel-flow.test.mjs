// Guest cancel page /book/cancel/{token} (src/pages/l/cancel.astro + src/lib/guestCancel.ts) against a mocked
// https://api.beautica.app: every state, one POST on double click, retry, no token leakage, CSP lets the API through.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { launch, open, mockCancelApi } from "./helpers/browser.mjs";
import { BASE, API_ORIGIN, TOKEN, uk, requireBase } from "./helpers/env.mjs";

requireBase();
const c = uk.cancel;
const PATH = `/book/cancel/${TOKEN}`;
const API_PATH = `/api/v1/book/cancel/${TOKEN}`;
const INFO = { masterName: "Олена Коваль", serviceName: "Манікюр з покриттям", startsAt: "2030-03-05T10:00:00Z", cancellable: true, windowClosesAt: "2030-03-05T08:00:00Z" };
const ok = (json) => ({ status: 200, json });
const ALL_STATES = ["loading", "confirm", "cancelled", "closed", "notfound", "error", "readonly"];

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

async function run(handlers, fn, { path = PATH, init, ...opts } = {}) {
  const env = await open(browser, { width: 360, height: 800, ...opts });
  if (init) await env.context.addInitScript(init);
  const calls = await mockCancelApi(env.context, handlers);
  try {
    await env.page.goto(BASE + path);
    await fn({ ...env, calls, state: (s) => env.page.locator(`#st-${s}`), confirm: env.page.getByRole("button", { name: c.confirm }) });
    assert.deepEqual(env.external, [], "only the mocked API origin may be contacted");
  } finally {
    await env.context.close();
  }
}
/** Exactly one of the six states is visible. */
async function assertOnlyState(page, name) {
  for (const s of ALL_STATES) assert.equal(await page.locator(`#st-${s}`).isVisible(), s === name, `#st-${s} visibility (expected only ${name})`);
}
const focusedId = (page) => page.evaluate(() => document.activeElement?.id);
/** One heading per state (audit): exactly one h1 in the accessibility tree, with the text of the state shown, and the focus is on it. */
const TITLE = { confirm: () => c.confirmTitle, closed: () => c.closedTitle, notfound: () => c.notfoundTitle, error: () => c.errorTitle, cancelled: () => c.doneTitle };
async function oneH1(page, st) {
  const h1 = page.getByRole("heading", { level: 1 });
  assert.equal(await h1.count(), 1, `${st}: exactly one h1`);
  assert.equal((await h1.innerText()).trim(), TITLE[st](), `${st}: the h1 is the state's own heading`);
  assert.equal(await page.getByRole("heading", { level: 2 }).count(), 0, `${st}: no second, stacked title`);
  assert.equal(await focusedId(page), "cancel-title", `${st}: focus moves to the heading`);
}
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const axeViolations = async (page) => {
  // Settled = fonts loaded and no running finite animation/transition (looping spinners excepted) (contrast is computed on the final colours).
  await page.waitForFunction(() => document.fonts.status === "loaded" && document.getAnimations().every((a) => a.effect.getComputedTiming().iterations === Infinity || a.playState === "finished"));
  await page.evaluate(AXE);
  const res = await page.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] }));
  return res.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
};
/** Two painted frames: any layout shift the last change causes has been reported (a condition, not a fixed sleep). */
const quiet = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Polls until `read()` is truthy (e.g. the mock saw the request); fails with `msg` after 15 s. */
async function until(read, msg) {
  const end = Date.now() + 15_000;
  while (!read() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.ok(read(), msg);
}
/** The status call was answered and the reserved space under the confirm button is settled (released when there is no block). */
const releasedSpace = (page) => page.waitForFunction(() => { const e = document.querySelector(".rc"); return !!e && !e.hasAttribute("data-reserve"); });
const expected = (problems, re) => assert.deepEqual(problems.filter((p) => !re.test(p)), [], "unexpected console/page errors");

describe("loading the booking", () => {
  test("a cancellable booking shows the confirm state with master, service, time (Kyiv) and the deadline, focused", async () => {
    await run({ get: () => ok(INFO) }, async ({ page, state, problems }) => {
      await state("confirm").waitFor({ state: "visible" });
      await assertOnlyState(page, "confirm");
      assert.equal(await page.locator("#c-facts [data-fact=master] .t-value-12").innerText(), INFO.masterName);
      assert.equal(await page.locator("#c-facts [data-fact=service] .t-value-12").innerText(), INFO.serviceName);
      assert.match(await page.locator("#c-facts [data-fact=when] .t-value-12").innerText(), /5 березня.*12:00/); // 10:00Z = 12:00 in Europe/Kyiv (winter)
      assert.match(await page.locator("#c-until").innerText(), /^Скасувати можна до 5 березня.*10:00\.$/);
      assert.equal(await page.getByRole("heading", { name: c.confirmTitle }).isVisible(), true);
      await oneH1(page, "confirm");
      assert.deepEqual(problems, []);
    });
  });

  test("regression: every recap row has its label and value on ONE row (same top, label left of value), at 360 and 768", async () => {
    for (const width of [360, 768])
      await run({ get: () => ok(INFO) }, async ({ page, state }) => {
        await state("confirm").waitFor({ state: "visible" });
        const rows = await page.locator("#c-facts .kv").evaluateAll((els) =>
          els.map((e) => ({ fact: e.dataset.fact, l: e.querySelector(".t-label").getBoundingClientRect().toJSON(), v: e.querySelector(".t-value-12").getBoundingClientRect().toJSON() })));
        assert.deepEqual(rows.map((r) => r.fact), ["master", "service", "when"]);
        for (const r of rows) {
          assert.ok(r.l.width > 0 && r.v.width > 0, `${r.fact}: both boxes are painted`);
          assert.ok(Math.abs(r.l.y - r.v.y) < 6, `${r.fact} @${width}: label y ${r.l.y} vs value y ${r.v.y} (stacked?)`);
          assert.ok(r.l.right <= r.v.left + 1, `${r.fact} @${width}: the label sits left of the value`);
        }
      }, { width });
  });

  test("the lookup is one credential-less GET to the exact API path (no cookie, no referrer, JSON accepted)", async () => {
    await run({ get: () => ok(INFO) }, async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[0].url, API_ORIGIN + API_PATH);
      assert.equal(calls[0].headers["accept"], "application/json");
      assert.equal(calls[0].headers["cookie"], undefined);
      assert.equal(calls[0].headers["authorization"], undefined);
      assert.equal(calls[0].headers["referer"], undefined, "the token URL must not be sent as Referer");
    });
  });

  test("shows the loading state until the API answers", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    await run({ get: async () => (await gate, ok(INFO)) }, async ({ page, state }) => {
      await state("loading").waitFor({ state: "visible" });
      await assertOnlyState(page, "loading");
      assert.equal(await page.getByText(c.loading).isVisible(), true);
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, "loading: one h1");
      assert.equal((await page.getByRole("heading", { level: 1 }).innerText()).trim(), c.h1, "loading: the static «Скасування запису»");
      release();
      await state("confirm").waitFor({ state: "visible" });
    });
    release();
  });

  test("cancellable:false shows «closed» with the 2-hour explanation", async () => {
    await run({ get: () => ok({ ...INFO, cancellable: false }) }, async ({ page, state }) => {
      await state("closed").waitFor({ state: "visible" });
      await assertOnlyState(page, "closed");
      assert.equal(await page.getByRole("heading", { name: c.closedTitle }).isVisible(), true);
      assert.equal(await page.getByText(c.closedText).isVisible(), true);
      await oneH1(page, "closed");
    });
  });

  for (const [status, st] of [[422, "closed"], [404, "notfound"], [400, "notfound"], [500, "error"], [503, "error"], [429, "error"]]) {
    test(`GET ${status} shows «${st}»`, async () => {
      await run({ get: () => ({ status }) }, async ({ page, state, problems }) => {
        await state(st).waitFor({ state: "visible" });
        await assertOnlyState(page, st);
        await oneH1(page, st);
        expected(problems, /status of \d\d\d/);
      });
    });
  }

  test("a network failure shows «error»; Retry asks again and recovers to «confirm»", async () => {
    let asked = 0;
    await run({ get: () => (asked++ === 0 ? "abort" : ok(INFO)) }, async ({ page, state, calls }) => {
      await state("error").waitFor({ state: "visible" });
      assert.equal(await page.getByRole("heading", { name: c.errorTitle }).isVisible(), true);
      await page.getByRole("button", { name: c.retry }).click();
      await state("confirm").waitFor({ state: "visible" });
      await assertOnlyState(page, "confirm");
      assert.equal(calls.length, 2);
    });
  });
});

describe("confirming the cancel", () => {
  test("confirm sends one credential-less POST and shows «cancelled» (204), focused", async () => {
    await run({ get: () => ok(INFO), post: () => ({ status: 204 }) }, async ({ page, state, confirm, calls, problems }) => {
      await state("confirm").waitFor({ state: "visible" });
      await confirm.click();
      await state("cancelled").waitFor({ state: "visible" });
      await assertOnlyState(page, "cancelled");
      assert.equal(await page.getByRole("heading", { name: c.doneTitle }).isVisible(), true);
      await oneH1(page, "cancelled");
      const posts = calls.filter((x) => x.method === "POST");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].url, API_ORIGIN + API_PATH);
      assert.equal(posts[0].headers["cookie"], undefined);
      assert.equal(posts[0].headers["referer"], undefined);
      assert.deepEqual(problems, []);
    });
  });

  test("double click sends exactly one POST; the button is busy and relabelled meanwhile", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    await run({ get: () => ok(INFO), post: async () => (await gate, { status: 204 }) }, async ({ page, state, confirm, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      await confirm.dblclick();
      const busy = page.getByRole("button", { name: c.cancelling });
      await busy.waitFor({ state: "visible" });
      assert.equal(await busy.isDisabled(), true);
      assert.equal(await busy.getAttribute("aria-busy"), "true");
      release();
      await state("cancelled").waitFor({ state: "visible" });
      assert.equal(calls.filter((x) => x.method === "POST").length, 1);
    });
    release();
  });

  for (const [status, st] of [[404, "notfound"], [422, "closed"], [500, "error"]]) {
    test(`POST ${status} shows «${st}»`, async () => {
      await run({ get: () => ok(INFO), post: () => ({ status }) }, async ({ page, state, confirm, problems }) => {
        await state("confirm").waitFor({ state: "visible" });
        await confirm.click();
        await state(st).waitFor({ state: "visible" });
        await assertOnlyState(page, st);
        expected(problems, /status of \d\d\d/);
      });
    });
  }

  test("a failed POST then Retry reloads the booking (the link may have been used meanwhile)", async () => {
    const seq = [ok(INFO), { status: 500 }, { status: 404 }];
    let i = 0;
    await run({ get: () => (i++ === 0 ? seq[0] : seq[2]), post: () => seq[1] }, async ({ page, state, confirm }) => {
      await state("confirm").waitFor({ state: "visible" });
      await confirm.click();
      await state("error").waitFor({ state: "visible" });
      await page.getByRole("button", { name: c.retry }).click();
      await state("notfound").waitFor({ state: "visible" });
    });
  });
});

describe("the link itself", () => {
  // Malformed tokens are refused by the Worker with the 404 page (no cancel shell at all); see tests/headers-seo.test.mjs for status + headers.
  const assertServer404 = async (page, calls) => {
    await page.waitForLoadState("load");
    assert.equal(await page.locator("#cancel-root").count(), 0, "the 404 page, not the cancel shell");
    assert.equal(calls.length, 0);
  };
  test("a malformed token never reaches the API: the server answers with the 404 page", async () => {
    await run({ get: () => ok(INFO) }, async ({ page, calls }) => assertServer404(page, calls), { path: "/book/cancel/not-a-token" });
  });

  test("the short link /c/{16} renders the confirm page; the token is forwarded unchanged (case kept)", async () => {
    const short = "Ab3dEf7hJk9mNp2Q";
    await run({ get: () => ok(INFO) }, async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      assert.equal(calls[0].url, `${API_ORIGIN}/api/v1/book/cancel/${short}`);
      await assertOnlyState(page, "confirm");
    }, { path: `/c/${short}` });
  });

  test("the short link with a trailing slash redirects to the slash-less URL and still renders", async () => {
    await run({ get: () => ok(INFO) }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      assert.equal(new URL(page.url()).pathname, "/c/Ab3dEf7hJk9mNp2Q");
    }, { path: "/c/Ab3dEf7hJk9mNp2Q/" });
  });

  for (const bad of ["/c/Ab3dEf7hJk9mNp2", "/c/Ab3dEf7hJk9mNp2QQ", "/c/Ab3dEf7hJk9mNp2-", "/c/Ab3dEf7hJk9mNp2_"]) {
    test(`${bad}: the server answers with the 404 page and never reaches the API`, async () => {
      await run({ get: () => ok(INFO) }, async ({ page, calls }) => assertServer404(page, calls), { path: bad });
    });
  }

  test("an upper-case token is accepted and forwarded as written", async () => {
    const upper = TOKEN.toUpperCase();
    await run({ get: () => ok(INFO) }, async ({ state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      assert.equal(calls[0].url, `${API_ORIGIN}/api/v1/book/cancel/${upper}`);
    }, { path: `/book/cancel/${upper}` });
  });

  test("no request from this page carries the token URL as Referer (fonts, scripts, images, API)", async () => {
    const env = await open(browser, { width: 360 });
    const referers = [];
    env.page.on("request", (r) => r.headers()["referer"] && referers.push(`${r.url()} <- ${r.headers()["referer"]}`));
    await mockCancelApi(env.context, { get: () => ok(INFO) });
    try {
      await env.page.goto(BASE + PATH, { waitUntil: "networkidle" });
      await env.page.locator("#st-confirm").waitFor({ state: "visible" });
      // No request may name the token: a module chunk's Referer may only be its importing /_astro/*.js script (same origin, not the credential).
      assert.deepEqual(referers.filter((r) => r.includes(TOKEN)), [], "no Referer carries the token");
      assert.deepEqual(referers.filter((r) => !/ <- \S+\/_astro\/[^/\s]+\.js$/.test(r)), [], "any Referer is an /_astro/*.js chunk");
    } finally {
      await env.context.close();
    }
  });

  test("CSP lets the API origin through (no violation) and refuses any other origin", async () => {
    await run({ get: () => ok(INFO) }, async ({ page, state, problems }) => {
      await state("confirm").waitFor({ state: "visible" });
      assert.deepEqual(problems, [], "the API call itself must not violate the CSP");
      const outcome = await page.evaluate(() => fetch("https://evil.example/x").then(() => "allowed", () => "blocked"));
      assert.equal(outcome, "blocked");
      assert.ok(problems.some((p) => /Content Security Policy/.test(p) && /evil\.example/.test(p)), `no CSP violation logged: ${problems}`);
    });
  });

  test("at 1280 px the confirm button is reachable by keyboard and Enter cancels", async () => {
    await run({ get: () => ok(INFO), post: () => ({ status: 204 }) }, async ({ page, state, confirm }) => {
      await state("confirm").waitFor({ state: "visible" });
      await confirm.focus();
      await page.keyboard.press("Enter");
      await state("cancelled").waitFor({ state: "visible" });
    }, { width: 1280 });
  });
});

// Phase 024: the reminder-channel block of the cancel page (ReminderChannelChoice + reminder-channel.ts, reused from the done screen).
// The status answer alone decides (never the booking source): offerChoice -> radios; linked -> status + «Відписатися від Telegram»; otherwise nothing.
describe("reminder channel on the cancel page (phase 024)", () => {
  const CLS = `window.__cls=0;new PerformanceObserver(function(l){for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value}).observe({type:"layout-shift",buffered:true});`;
  const r = uk.book.done.reminders;
  /** Handlers for mockCancelApi: `telegram(req)` answers by endpoint name (status / unlink / link-token); unlisted = 404. */
  const tgApi = (tg, extra = {}) => ({
    get: () => ok(INFO),
    post: () => ({ status: 204 }),
    telegram: (req) => tg[new URL(req.url()).pathname.split("/").pop()] ?? { status: 404 },
    ...extra,
  });
  const STATUS = (o) => ({ status: 200, json: { available: true, linked: false, offerChoice: false, ...o } });
  const tgCalls = (calls) => calls.telegram;
  const block = (page) => page.locator("#done-reminders");

  test("offerChoice:true shows SMS preselected + Telegram; one status POST (token in the body only); selecting changes nothing; CLS and axe clean", async () => {
    await run(tgApi({ status: STATUS({ offerChoice: true }) }), async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      await block(page).waitFor({ state: "visible" });
      await quiet(page);
      const cls = await page.evaluate(() => window.__cls);
      console.log("cancel page CLS (confirm + block):", cls);
      assert.ok(cls <= 0.005, `CLS ${cls}`);
      assert.equal(await page.locator("#done-reminders .seg[role=group] input[type=radio][name=reminder-channel]").count(), 2);
      assert.equal(await page.locator("#done-reminders input[value=sms]").isChecked(), true);
      const box = await page.locator("#done-reminders label:has(input[value=telegram])").boundingBox();
      assert.ok(box && box.width > 0 && box.height >= 47.99, "segment is a 48 px target (sub-pixel rounding tolerated)");
      await page.locator("#done-reminders input[value=sms]").focus();
      await page.keyboard.press("ArrowRight");
      await page.locator("[data-r-connect]").waitFor({ state: "visible" });
      const tg = tgCalls(calls);
      assert.equal(tg.length, 1, "arrow-key selection sends nothing beyond the status read");
      assert.ok(tg[0].url.endsWith("/api/v1/book/telegram/status") && !tg[0].url.includes(TOKEN), "token is not in the URL");
      assert.deepEqual(JSON.parse(tg[0].body), { cancelToken: TOKEN }, "the cancel token travels in the body only");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll");
      assert.deepEqual(await axeViolations(page), []);
    }, { init: CLS, height: 640 });
  });

  test("linked:true shows the Telegram status + «Відписатися від Telegram»; the unlink POST returns the choice; axe clean", async () => {
    await run(tgApi({ status: { status: 200, json: { available: true, linked: true, offerChoice: false } }, unlink: { status: 204 } }), async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      await block(page).waitFor({ state: "visible" });
      assert.equal(await page.getByText(r.linked).isVisible(), true);
      await quiet(page);
      assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, "linked: CLS");
      assert.equal(await page.locator("#done-reminders .seg").isVisible(), false);
      assert.deepEqual(await axeViolations(page), []);
      await page.getByRole("button", { name: r.backToSms }).click();
      await page.locator("#done-reminders input[value=sms]").waitFor({ state: "visible" });
      assert.equal(await page.locator("#done-reminders input[value=sms]").isChecked(), true);
      assert.equal(tgCalls(calls).filter((c) => c.url.endsWith("/unlink")).length, 1);
    }, { init: CLS, height: 640 });
  });

  for (const [name, status] of [
    ["a booking-link guest who is not linked (offerChoice:false)", STATUS({})],
    ["available:false", STATUS({ available: false, offerChoice: true })],
    ["a 404 (not eligible / feature off)", { status: 404 }],
    ["a malformed answer", { status: 200, json: { ok: 1 } }],
  ]) {
    test(`block absent: ${name}`, async () => {
      await run(tgApi({ status }), async ({ page, state, calls }) => {
        await state("confirm").waitFor({ state: "visible" });
        await until(() => tgCalls(calls).length >= 1, "the status call was made");
        await releasedSpace(page);
        await quiet(page);
        assert.equal(tgCalls(calls).length, 1);
        assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, "no block: CLS");
        assert.equal(await block(page).isVisible(), false);
        assert.equal(await block(page).count(), 1);
        // The reserved space is released (no blank gap) and the footer is back, with no layout shift.
        const gap = await page.locator(".rc").evaluate((e) => ({ h: e.getBoundingClientRect().height, reserved: e.hasAttribute("data-reserve") }));
        assert.deepEqual(gap, { h: 0, reserved: false }, "no gap left when there is no block");
        assert.equal(await page.locator(".site-footer").isVisible(), true);
        assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, "no block, after the release: CLS");
      }, { init: CLS, height: 640 });
    });
  }

  test("a network failure of the status call leaves the cancel page exactly as before", async () => {
    await run({ get: () => ok(INFO), telegram: () => "abort" }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      await releasedSpace(page);
      await quiet(page);
      assert.equal(await block(page).isVisible(), false);
      assert.equal(await page.getByRole("button", { name: c.confirm }).isVisible(), true);
    });
  });

  test("closed, unknown and malformed tokens never show the block and never call /book/telegram/status", async () => {
    const offer = tgApi({ status: STATUS({ offerChoice: true }) });
    await run({ ...offer, get: () => ok({ ...INFO, cancellable: false }) }, async ({ page, state, calls }) => {
      await state("closed").waitFor({ state: "visible" });
      await quiet(page);
      assert.equal(await block(page).isVisible(), false);
      assert.equal(calls.telegram.length, 0, "closed: no status call");
      assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, "closed: CLS");
    }, { init: CLS, height: 640 });
    await run({ ...offer, get: () => ({ status: 404 }) }, async ({ page, state, calls, problems }) => {
      await state("notfound").waitFor({ state: "visible" });
      await quiet(page);
      assert.equal(calls.telegram.length, 0, "unknown / used: no status call");
      assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, "notfound: CLS");
      expected(problems, /status of 404/); // the lookup's own 404 is the only console noise
      assert.equal(problems.filter((p) => /telegram/.test(p)).length, 0);
    }, { init: CLS, height: 640 });
    await run(offer, async ({ page, calls }) => {
      await page.waitForLoadState("load");
      assert.equal(await page.locator("#cancel-root").count(), 0, "the 404 page, not the cancel shell");
      assert.equal(calls.telegram.length, 0, "malformed token: no status call");
    }, { path: "/book/cancel/not-a-token" });
  });

  test("a successful cancellation hides the block", async () => {
    await run(tgApi({ status: STATUS({ offerChoice: true }) }), async ({ page, state, confirm, calls }) => {
      await block(page).waitFor({ state: "visible" });
      assert.equal(calls.telegram.length, 1);
      await confirm.click();
      await state("cancelled").waitFor({ state: "visible" });
      assert.equal(await block(page).isVisible(), false);
      assert.equal(calls.telegram.length, 1, "cancelled: no further status call");
    });
  });
});

// Phase 435: GET now answers 200 for non-CONFIRMED bookings (status + rebookPath): a read-only view, never a cancel offer.
describe("read-only states (phase 435)", () => {
  const cases = [
    ["CANCELLED", c.doneTitle, c.ro.cancelledText],
    ["DECLINED", c.doneTitle, c.ro.cancelledText],
    ["COMPLETED", c.ro.completedTitle, c.ro.completedText],
    ["NOT_COMPLETED", c.ro.notCompletedTitle, c.ro.notCompletedText],
    ["SOMETHING_NEW", c.ro.otherTitle, null],
  ];
  for (const [status, title, text] of cases) {
    test(`${status}: details, heading «${title}», rebook link, no cancel`, async () => {
      await run({ get: () => ok({ ...INFO, cancellable: false, status, rebookPath: "/book/olena-koval" }) }, async ({ page, state, calls, confirm }) => {
        await state("readonly").waitFor({ state: "visible" });
        await assertOnlyState(page, "readonly");
        const h1 = page.getByRole("heading", { level: 1 });
        assert.equal(await h1.count(), 1);
        assert.equal((await h1.innerText()).trim(), title);
        assert.equal(await focusedId(page), "cancel-title");
        assert.equal((await page.locator("#r-facts [data-fact=master] .t-value-12").innerText()).trim(), INFO.masterName);
        assert.equal((await page.locator("#r-facts [data-fact=service] .t-value-12").innerText()).trim(), INFO.serviceName);
        assert.match(await page.locator("#r-facts [data-fact=when] .t-value-12").innerText(), /5 березня/);
        if (text) assert.equal(await page.getByText(text).isVisible(), true);
        else assert.equal(await page.locator("#r-text").isVisible(), false);
        assert.equal(await confirm.count(), 0, "no visible cancel button");
        assert.equal(await page.locator("#st-readonly button").count(), 0, "the read-only view contains no button");
        const rebook = page.getByRole("link", { name: c.rebook });
        assert.equal(await rebook.isVisible(), true);
        assert.equal(await rebook.getAttribute("href"), "/book/olena-koval");
        const box = await rebook.boundingBox();
        assert.ok(box && box.width > 0 && box.height >= 48, "rebook button has a real box");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll");
        assert.equal(calls.length, 1, "one GET, no POST");
        assert.equal(calls.filter((x) => x.method === "POST").length, 0);
      });
    });
  }

  test("rebookPath null hides the button; a salon path is kept; a foreign URL is dropped", async () => {
    await run({ get: () => ok({ ...INFO, cancellable: false, status: "COMPLETED", rebookPath: null }) }, async ({ page, state }) => {
      await state("readonly").waitFor({ state: "visible" });
      assert.equal(await page.getByRole("link", { name: c.rebook }).isVisible(), false);
    });
    await run({ get: () => ok({ ...INFO, cancellable: false, status: "CANCELLED", rebookPath: "/book/s/beauty-room" }) }, async ({ page, state }) => {
      await state("readonly").waitFor({ state: "visible" });
      assert.equal(await page.getByRole("link", { name: c.rebook }).getAttribute("href"), "/book/s/beauty-room");
    });
    await run({ get: () => ok({ ...INFO, cancellable: false, status: "CANCELLED", rebookPath: "https://evil.example/x" }) }, async ({ page, state }) => {
      await state("readonly").waitFor({ state: "visible" });
      assert.equal(await page.getByRole("link", { name: c.rebook }).isVisible(), false);
    });
  });

  test("rebookPath naming the cancel token route is dropped; slugs merely starting with «cancel» are kept", async () => {
    for (const bad of ["/book/cancel", "/book/s/cancel"]) {
      await run({ get: () => ok({ ...INFO, cancellable: false, status: "CANCELLED", rebookPath: bad }) }, async ({ page, state }) => {
        await state("readonly").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("link", { name: c.rebook }).isVisible(), false, bad);
      });
    }
    for (const good of ["/book/cancelia", "/book/cancel-studio", "/book/s/cancel-studio"]) {
      await run({ get: () => ok({ ...INFO, cancellable: false, status: "CANCELLED", rebookPath: good }) }, async ({ page, state }) => {
        await state("readonly").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("link", { name: c.rebook }).getAttribute("href"), good);
      });
    }
  });

  test("status CONFIRMED (and an older backend without status) keeps today's behaviour", async () => {
    await run({ get: () => ok({ ...INFO, status: "CONFIRMED", rebookPath: "/book/x" }) }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      await assertOnlyState(page, "confirm");
    });
    await run({ get: () => ok({ ...INFO, status: "CONFIRMED", cancellable: false }) }, async ({ page, state }) => {
      await state("closed").waitFor({ state: "visible" });
      await assertOnlyState(page, "closed");
    });
  });

  test("the read-only view fits 360 / 768 / 1280 px and sends the token nowhere but the API path", async () => {
    for (const width of [360, 768, 1280]) {
      await run({ get: () => ok({ ...INFO, cancellable: false, status: "DECLINED", rebookPath: "/book/olena-koval" }) }, async ({ page, state, calls }) => {
        await state("readonly").waitFor({ state: "visible" });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: no horizontal scroll`);
        assert.equal(calls[0].url, `${API_ORIGIN}${API_PATH}`);
      }, { width });
    }
  });
});

// Phase 435: optional salonName / address facts, in the confirm and the read-only view; text only.
describe("salon and address facts (phase 435)", () => {
  const views = [
    ["confirm", "c", {}],
    ["readonly", "r", { cancellable: false, status: "COMPLETED", rebookPath: null }],
  ];
  for (const [st, p, extra] of views) {
    test(`${st}: salon and address are shown with their labels`, async () => {
      await run({ get: () => ok({ ...INFO, ...extra, salonName: "Beauty Room", address: "Київ, вул. Хрещатик, 1" }) }, async ({ page, state }) => {
        await state(st).waitFor({ state: "visible" });
        assert.equal(await page.locator(`#${p}-facts [data-fact=salon]`).isVisible(), true);
        assert.equal(await page.locator(`#${p}-facts [data-fact=address]`).isVisible(), true);
        assert.equal((await page.locator(`#${p}-facts [data-fact=salon] .t-label`).innerText()).trim(), c.salon);
        assert.equal((await page.locator(`#${p}-facts [data-fact=address] .t-label`).innerText()).trim(), c.address);
        assert.equal((await page.locator(`#${p}-facts [data-fact=salon] .t-value-12`).innerText()).trim(), "Beauty Room");
        assert.equal((await page.locator(`#${p}-facts [data-fact=address] .t-value-12`).innerText()).trim(), "Київ, вул. Хрещатик, 1");
      });
    });

    test(`${st}: locationNote follows the address in brackets, as text`, async () => {
      await run({ get: () => ok({ ...INFO, ...extra, address: "Хрещатик 10", locationNote: "вхід з двору" }) }, async ({ page, state }) => {
        await state(st).waitFor({ state: "visible" });
        assert.equal((await page.locator(`#${p}-facts [data-fact=address] .t-value-12`).innerText()).trim(), "Хрещатик 10 (вхід з двору)");
      });
      await run({ get: () => ok({ ...INFO, ...extra, address: "Хрещатик 10", locationNote: "<b>x</b>" }) }, async ({ page, state }) => {
        await state(st).waitFor({ state: "visible" });
        assert.equal((await page.locator(`#${p}-facts [data-fact=address] .t-value-12`).innerText()).trim(), "Хрещатик 10 (<b>x</b>)");
        assert.equal(await page.locator(`#${p}-facts [data-fact=address] .t-value-12 *`).count(), 0);
      });
    });

    test(`${st}: no note = plain address; a note without an address shows no row`, async () => {
      for (const body of [{ address: "Хрещатик 10", locationNote: null }, { address: "Хрещатик 10", locationNote: "  " }, { address: "Хрещатик 10" }]) {
        await run({ get: () => ok({ ...INFO, ...extra, ...body }) }, async ({ page, state }) => {
          await state(st).waitFor({ state: "visible" });
          assert.equal((await page.locator(`#${p}-facts [data-fact=address] .t-value-12`).innerText()).trim(), "Хрещатик 10");
        });
      }
      for (const body of [{ address: null, locationNote: "вхід з двору" }, { locationNote: "вхід з двору" }, { address: " ", locationNote: "вхід з двору" }]) {
        await run({ get: () => ok({ ...INFO, ...extra, ...body }) }, async ({ page, state }) => {
          await state(st).waitFor({ state: "visible" });
          assert.equal(await page.locator(`#${p}-facts [data-fact=address]`).isVisible(), false);
          assert.equal(await page.locator(`#${p}-facts [data-fact=address]`).count(), 0);
        });
      }
    });

    test(`${st}: null, blank or absent values leave both rows hidden`, async () => {
      for (const body of [{ salonName: null, address: null }, { salonName: "  ", address: "" }, {}]) {
        await run({ get: () => ok({ ...INFO, ...extra, ...body }) }, async ({ page, state }) => {
          await state(st).waitFor({ state: "visible" });
          assert.equal(await page.locator(`#${p}-facts [data-fact=salon]`).isVisible(), false);
          assert.equal(await page.locator(`#${p}-facts [data-fact=address]`).isVisible(), false);
          assert.equal(await page.getByText(c.salon, { exact: true }).count() === 0 || !(await page.getByText(c.salon, { exact: true }).first().isVisible()), true);
        });
      }
    });

    test(`${st}: an HTML-looking value is rendered as text, never as markup`, async () => {
      const evil = '<img src=x onerror="window.__pwn=1"><b>Салон</b>';
      await run({ get: () => ok({ ...INFO, ...extra, salonName: evil, address: "<script>window.__pwn=1</script>" }) }, async ({ page, state }) => {
        await state(st).waitFor({ state: "visible" });
        assert.equal((await page.locator(`#${p}-facts [data-fact=salon] .t-value-12`).innerText()).trim(), evil);
        assert.equal((await page.locator(`#${p}-facts [data-fact=address] .t-value-12`).innerText()).trim(), "<script>window.__pwn=1</script>");
        assert.equal(await page.locator(`#${p}-facts .t-value-12 *`).count(), 0, "no child elements were created");
        assert.equal(await page.evaluate(() => window.__pwn), undefined);
      });
    });
  }

  test("the read-only view with salon and address rows has no axe violations at 360 px, with the rebook link", async () => {
    await run({ get: () => ok({ ...INFO, cancellable: false, status: "COMPLETED", rebookPath: "/book/olena-koval", salonName: "Beauty Room", address: "Київ, вул. Хрещатик, 1" }) }, async ({ page, state }) => {
      await state("readonly").waitFor({ state: "visible" });
      assert.equal(await page.locator("#r-facts [data-fact=salon]").isVisible(), true, "salon row shown");
      assert.equal(await page.locator("#r-facts [data-fact=address]").isVisible(), true, "address row shown");
      assert.equal(await page.getByRole("link", { name: c.rebook }).isVisible(), true, "rebook shown");
      assert.deepEqual(await axeViolations(page), []);
    });
  });
});

// Phase 026: several services = the guest ticks what to cancel (src/pages/l/cancel.astro + src/lib/guestCancel.ts). Copy comes from uk.json (cancel.multi.*).
describe("pick the services to cancel (phase 026)", () => {
  const m = c.multi;
  const fill = (s, v) => s.replace("{n}", v);
  const item = (n, serviceName, h, status = "CONFIRMED", cancellable = true) => ({ bookingId: `b${n}`, serviceName, startsAt: `2030-03-05T${h}:00:00Z`, durationMinutes: 60, status, cancellable });
  const A = item(1, "Манікюр з покриттям", "10");
  const B = item(2, "Педикюр класичний", "11");
  const C = item(3, "Догляд за бровами", "12");
  const MULTI = { ...INFO, status: "CONFIRMED", items: [A, B, C] };
  /** The mock backend's POST (stateful, like the real one): cancels the listed ids (no body = every open service) and answers in the GET shape. */
  const cancelling = (base, bodies = []) => {
    const gone = new Set();
    return (req) => {
      const sent = req.postData() ? JSON.parse(req.postData()).bookingIds : undefined;
      bodies.push(sent);
      for (const i of base.items) if (i.cancellable && (!sent || sent.includes(i.bookingId))) gone.add(i.bookingId);
      const items = base.items.map((i) => (gone.has(i.bookingId) ? { ...i, status: "CANCELLED", cancellable: false } : i));
      return ok({ ...base, items, cancellable: items.some((i) => i.cancellable) });
    };
  };
  const row = (page, name) => page.locator("#c-rows label", { hasText: name });
  const box = (page, name) => row(page, name).locator("input[type=checkbox]");
  const cta = (page) => page.locator("#c-confirm");
  const ctaText = async (page) => (await cta(page).innerText()).trim();
  const posts = (calls) => calls.filter((x) => x.method === "POST");

  test("nothing is ticked at first: every cancellable row is an unticked checkbox, the CTA is disabled and says «Скасувати»", async () => {
    await run({ get: () => ok(MULTI) }, async ({ page, state, calls, problems }) => {
      await state("confirm").waitFor({ state: "visible" });
      await assertOnlyState(page, "confirm");
      assert.equal(await page.locator("#c-rows input[type=checkbox]").count(), 3);
      assert.equal(await page.locator("#c-rows input:checked").count(), 0, "nothing preselected");
      assert.equal(await cta(page).isDisabled(), true);
      assert.equal(await ctaText(page), m.confirmNone);
      assert.equal(await page.getByRole("group", { name: m.hint }).isVisible(), true, "a fieldset named by the hint");
      assert.deepEqual(await page.locator("#c-rows label .name").allInnerTexts(), [A, B, C].map((i) => i.serviceName), "ordered by time, one row per service");
      assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), m.title);
      assert.equal(await page.locator("#c-facts [data-fact=service]").count(), 0, "the service row of the single view is replaced by the list");
      assert.equal(await page.locator("#c-status").isVisible(), false, "no result line before any cancel");
      assert.equal(posts(calls).length, 0);
      assert.deepEqual(problems, []);
    });
  });

  test("ticking updates the CTA label (1 / 2 / 5 / 11 services, uk plural) and unticking everything disables it again", async () => {
    const many = { ...INFO, items: Array.from({ length: 11 }, (_, i) => item(i + 1, `Послуга ${i + 1}`, String(10 + (i % 10)).padStart(2, "0"))) };
    await run({ get: () => ok(many) }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      const forms = [[1, m.confirmOne], [2, m.confirmFew], [5, m.confirmMany], [11, m.confirmMany]];
      let ticked = 0;
      for (const [n, form] of forms) {
        for (; ticked < n; ticked++) await page.locator("#c-rows label").nth(ticked).click();
        assert.equal(await ctaText(page), fill(form, n), `${n} ticked`);
        assert.equal(await cta(page).isEnabled(), true);
      }
      for (let i = 0; i < 11; i++) await page.locator("#c-rows label").nth(i).click();
      assert.equal(await ctaText(page), m.confirmNone);
      assert.equal(await cta(page).isDisabled(), true);
    });
  });

  test("the POST body is exactly the ticked ids (first + last, then the middle one alone), as JSON", async () => {
    const bodies = [];
    await run({ get: () => ok(MULTI), post: cancelling(MULTI, bodies) }, async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      await row(page, A.serviceName).click();
      await row(page, C.serviceName).click();
      await cta(page).click();
      await page.locator("#c-status").waitFor({ state: "visible" });
      assert.equal(posts(calls).length, 1);
      assert.equal(posts(calls)[0].url, API_ORIGIN + API_PATH);
      assert.match(posts(calls)[0].headers["content-type"], /application\/json/);
      assert.deepEqual(JSON.parse(posts(calls)[0].body), { bookingIds: ["b1", "b3"] });
      // any service may be cancelled, a middle one too
      await row(page, B.serviceName).click();
      await cta(page).click();
      await state("cancelled").waitFor({ state: "visible" });
      assert.deepEqual(bodies, [["b1", "b3"], ["b2"]]);
    });
  });

  test("not cancellable rows show their reason (cancelled / completed / too late) and cannot be ticked", async () => {
    const info = { ...INFO, items: [A, item(2, "Знята послуга", "11", "CANCELLED", false), item(3, "Завершена послуга", "12", "COMPLETED", false), item(4, "Пізня послуга", "13", "CONFIRMED", false), item(5, "Відхилена послуга", "14", "DECLINED", false)] };
    await run({ get: () => ok(info) }, async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      for (const [name, reason] of [["Знята послуга", m.reasonCancelled], ["Завершена послуга", m.reasonCompleted], ["Пізня послуга", m.reasonLate], ["Відхилена послуга", m.reasonCancelled]]) {
        assert.equal(await box(page, name).isDisabled(), true, `${name}: disabled`);
        assert.equal(await row(page, name).locator(".why").isVisible(), true, `${name}: reason visible`);
        assert.equal((await row(page, name).locator(".why").innerText()).trim(), reason, name);
        await row(page, name).click({ force: true });
        assert.equal(await box(page, name).isChecked(), false, `${name}: a click does not tick it`);
      }
      assert.equal(await row(page, A.serviceName).locator(".why").isVisible(), false, "a cancellable row has no reason");
      assert.equal(await cta(page).isDisabled(), true, "clicking disabled rows leaves the CTA disabled");
      assert.equal(posts(calls).length, 0);
    });
  });

  test("a partial cancel re-renders from the answer: «Скасовано N з M», the rest stays selectable and unticked, the CTA is disabled again", async () => {
    await run({ get: () => ok(MULTI), post: cancelling(MULTI) }, async ({ page, state, calls, problems }) => {
      await state("confirm").waitFor({ state: "visible" });
      await row(page, B.serviceName).click();
      await cta(page).click();
      const line = page.locator("#c-status");
      await line.waitFor({ state: "visible" });
      assert.equal((await line.innerText()).trim(), m.partial.replace("{done}", "1").replace("{total}", "3"));
      await assertOnlyState(page, "confirm");
      assert.equal(await box(page, B.serviceName).isDisabled(), true);
      assert.equal((await row(page, B.serviceName).locator(".why").innerText()).trim(), m.reasonCancelled);
      for (const i of [A, C]) {
        assert.equal(await box(page, i.serviceName).isEnabled(), true, `${i.serviceName} still selectable`);
        assert.equal(await box(page, i.serviceName).isChecked(), false, "nothing preselected after the re-render");
      }
      assert.equal(await cta(page).isDisabled(), true);
      assert.equal(await ctaText(page), m.confirmNone);
      assert.equal(await cta(page).getAttribute("aria-busy"), null, "no longer busy");
      assert.equal(posts(calls).length, 1);
      assert.deepEqual(problems, []);
    });
  });

  test("the last open row cancelled shows the final «Запис скасовано» state (also all services at once)", async () => {
    await run({ get: () => ok(MULTI), post: cancelling(MULTI) }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      await row(page, A.serviceName).click();
      await row(page, B.serviceName).click();
      await cta(page).click();
      await page.locator("#c-status").waitFor({ state: "visible" });
      await row(page, C.serviceName).click();
      await cta(page).click();
      await state("cancelled").waitFor({ state: "visible" });
      await assertOnlyState(page, "cancelled");
      await oneH1(page, "cancelled");
      assert.equal(await page.getByText(c.doneText).isVisible(), true);
    });
    await run({ get: () => ok(MULTI), post: cancelling(MULTI) }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      for (const i of [A, B, C]) await row(page, i.serviceName).click();
      await cta(page).click();
      await state("cancelled").waitFor({ state: "visible" });
      await assertOnlyState(page, "cancelled");
    });
  });

  test("a POST 422 shows «closed»; a POST 404 «notfound»; a GET with only a too-late CONFIRMED service shows «closed»", async () => {
    for (const [status, st] of [[422, "closed"], [404, "notfound"]])
      await run({ get: () => ok(MULTI), post: () => ({ status }) }, async ({ page, state, problems }) => {
        await state("confirm").waitFor({ state: "visible" });
        await row(page, A.serviceName).click();
        await cta(page).click();
        await state(st).waitFor({ state: "visible" });
        await assertOnlyState(page, st);
        expected(problems, /status of \d\d\d/);
      });
    const late = { ...INFO, items: [item(1, "Пізня", "10", "CONFIRMED", false), item(2, "Знята", "11", "CANCELLED", false)] };
    await run({ get: () => ok(late) }, async ({ page, state }) => {
      await state("closed").waitFor({ state: "visible" });
      await assertOnlyState(page, "closed");
    });
  });

  test("a failed POST (500) shows «error»; Retry reloads the list with nothing ticked", async () => {
    await run({ get: () => ok(MULTI), post: () => ({ status: 500 }) }, async ({ page, state, problems }) => {
      await state("confirm").waitFor({ state: "visible" });
      await row(page, A.serviceName).click();
      await cta(page).click();
      await state("error").waitFor({ state: "visible" });
      await page.getByRole("button", { name: c.retry }).click();
      await state("confirm").waitFor({ state: "visible" });
      assert.equal(await page.locator("#c-rows input:checked").count(), 0);
      assert.equal(await cta(page).isDisabled(), true);
      expected(problems, /status of 500/);
    });
  });

  test("an old backend without `items` keeps today's single-service view: no tick list, the service fact, the single button enabled", async () => {
    await run({ get: () => ok(INFO), post: () => ({ status: 204 }) }, async ({ page, state, confirm, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      assert.equal(await page.locator("#c-svcs").isVisible(), false);
      assert.equal(await page.locator("#c-rows input").count(), 0);
      assert.equal(await page.locator("#c-facts [data-fact=service] .t-value-12").innerText(), INFO.serviceName);
      assert.equal(await confirm.isEnabled(), true);
      await oneH1(page, "confirm");
      await confirm.click();
      await state("cancelled").waitFor({ state: "visible" });
      assert.equal(posts(calls)[0].body, null, "body-less POST");
    });
  });

  test("a single-item visit keeps the old flow: no checkbox, «Так, скасувати запис», a POST with no body (answer in the GET shape works)", async () => {
    const one = { ...INFO, items: [A] };
    await run({ get: () => ok(one), post: cancelling(one) }, async ({ page, state, confirm, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      assert.equal(await page.locator("#c-svcs").isVisible(), false);
      assert.equal(await page.locator("input[type=checkbox]").count(), 0);
      assert.equal(await confirm.isEnabled(), true);
      assert.equal(await page.locator("#c-facts [data-fact=service] .t-value-12").innerText(), INFO.serviceName);
      await oneH1(page, "confirm");
      await confirm.click();
      await state("cancelled").waitFor({ state: "visible" });
      assert.equal(posts(calls).length, 1);
      assert.equal(posts(calls)[0].body, null, "no body for a single-service visit");
    });
  });

  test("no POST is sent unless something is ticked (forced and scripted clicks on the disabled CTA)", async () => {
    await run({ get: () => ok(MULTI), post: cancelling(MULTI) }, async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      await cta(page).click({ force: true });
      await cta(page).evaluate((b) => b.click());
      // tick then untick: still nothing to send
      await row(page, A.serviceName).click();
      await row(page, A.serviceName).click();
      await cta(page).click({ force: true });
      await quiet(page);
      assert.equal(posts(calls).length, 0, "no POST at all");
      assert.equal(calls.length, 1, "only the GET");
    });
  });

  test("the tick list works by keyboard alone (Space ticks the focused checkbox, Tab reaches the CTA, Enter sends)", async () => {
    await run({ get: () => ok(MULTI), post: cancelling(MULTI) }, async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      await box(page, B.serviceName).focus();
      await page.keyboard.press("Space");
      assert.equal(await box(page, B.serviceName).isChecked(), true);
      assert.equal(await ctaText(page), fill(m.confirmOne, 1));
      await cta(page).focus();
      await page.keyboard.press("Enter");
      await page.locator("#c-status").waitFor({ state: "visible" });
      assert.deepEqual(JSON.parse(posts(calls)[0].body), { bookingIds: ["b2"] });
    });
  });

  test("every row is at least 48 px tall at 360 px (disabled ones too) and the page does not scroll sideways", async () => {
    const info = { ...INFO, items: [A, item(2, "Дуже довга назва послуги для перевірки переносу тексту у вузькому рядку", "11", "CONFIRMED", false), item(3, "Знята", "12", "CANCELLED", false)] };
    for (const width of [360, 1280])
      await run({ get: () => ok(info) }, async ({ page, state }) => {
        await state("confirm").waitFor({ state: "visible" });
        const rows = await page.locator("#c-rows label").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
        assert.equal(rows.length, 3);
        for (const r of rows) assert.ok(r.width > 0 && r.height >= 47.99, `@${width}: row ${r.width}x${r.height}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `@${width}: no horizontal scroll`);
        const b = await cta(page).boundingBox();
        assert.ok(b && b.height >= 47.99, "CTA is a 48 px target");
      }, { width });
  });

  test("the result line is an aria-live region, announced with its text and focused after a partial cancel (also with reduced motion)", async () => {
    await run({ get: () => ok(MULTI), post: cancelling(MULTI) }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      const line = page.locator("#c-status");
      assert.equal(await line.getAttribute("role"), "status");
      assert.equal(await line.getAttribute("aria-live"), "polite");
      await row(page, A.serviceName).click();
      await row(page, B.serviceName).click();
      await cta(page).click();
      await line.waitFor({ state: "visible" });
      const text = m.partial.replace("{done}", "2").replace("{total}", "3");
      assert.equal(await page.getByRole("status").filter({ hasText: text }).count(), 1, "the line is exposed as a status with the count");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "c-status", "focus moves to the result line");
      assert.deepEqual(await axeViolations(page), []);
    }, { reducedMotion: "reduce" });
  });

  test("the multi list has no axe violations at 360 px (ticked, with disabled rows)", async () => {
    const info = { ...INFO, items: [A, B, item(3, "Завершена", "12", "COMPLETED", false), item(4, "Пізня", "13", "CONFIRMED", false)] };
    await run({ get: () => ok(info) }, async ({ page, state }) => {
      await state("confirm").waitFor({ state: "visible" });
      await row(page, A.serviceName).click();
      assert.deepEqual(await axeViolations(page), []);
    });
  });

  test("the token and the booking ids never appear in any analytics or beacon request, nor in any URL but the API path", async () => {
    const env = await open(browser, { width: 360 });
    const urls = [];
    env.page.on("request", (r) => urls.push({ url: r.url(), method: r.method(), body: r.postData() ?? "" }));
    const calls = await mockCancelApi(env.context, { get: () => ok(MULTI), post: cancelling(MULTI) });
    try {
      await env.page.goto(BASE + PATH, { waitUntil: "networkidle" });
      await env.page.locator("#st-confirm").waitFor({ state: "visible" });
      await row(env.page, A.serviceName).click();
      await cta(env.page).click();
      await env.page.locator("#c-status").waitFor({ state: "visible" });
      await env.page.waitForLoadState("networkidle");
      assert.deepEqual(env.analytics, [], "no analytics script is even requested on this route");
      assert.deepEqual(env.external, []);
      // Strict allow-list: every http(s) request goes to this site (page assets) or to the API origin under /api/v1/book/. Any other origin fails.
      const origin = (u) => new URL(u).origin;
      const foreign = urls.filter((r) => /^https?:/.test(r.url) && origin(r.url) !== origin(BASE) && !(origin(r.url) === origin(API_ORIGIN) && new URL(r.url).pathname.startsWith("/api/v1/book/")));
      assert.deepEqual(foreign.map((r) => `${r.method} ${r.url}`), [], "only same-origin assets and the API's /api/v1/book/ may be contacted");
      assert.ok(urls.some((r) => origin(r.url) === origin(API_ORIGIN)), "the allow-list is not vacuous: the API was contacted");
      assert.deepEqual(env.problems, [], "no console error: a beacon the CSP refused before it left the browser would show up here");
      for (const r of urls) {
        if (r.url === BASE + PATH) continue; // the document itself
        if (r.url.startsWith(API_ORIGIN)) {
          assert.ok(!/b[123]\b/.test(r.url), "booking ids are not in a URL");
          continue;
        }
        assert.ok(!r.url.includes(TOKEN) && !/bookingIds/.test(r.url + r.body), `no token / ids in ${r.url}`);
      }
      assert.deepEqual(JSON.parse(calls.find((x) => x.method === "POST").body), { bookingIds: ["b1"] }, "ids travel in the POST body only");
      assert.ok(!calls.some((x) => x.url.includes("b1")), "no cancel call has an id in its URL");
    } finally {
      await env.context.close();
    }
  });
});
