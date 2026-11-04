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
const expected = (problems, re) => assert.deepEqual(problems.filter((p) => !re.test(p)), [], "unexpected console/page errors");

describe("loading the booking", () => {
  test("a cancellable booking shows the confirm state with master, service, time (Kyiv) and the deadline, focused", async () => {
    await run({ get: () => ok(INFO) }, async ({ page, state, problems }) => {
      await state("confirm").waitFor({ state: "visible" });
      await assertOnlyState(page, "confirm");
      assert.equal(await page.locator("#c-master").innerText(), INFO.masterName);
      assert.equal(await page.locator("#c-service").innerText(), INFO.serviceName);
      assert.match(await page.locator("#c-when").innerText(), /5 березня.*12:00/); // 10:00Z = 12:00 in Europe/Kyiv (winter)
      assert.match(await page.locator("#c-until").innerText(), /^Скасувати можна до 5 березня.*10:00\.$/);
      assert.equal(await page.getByRole("heading", { name: c.confirmTitle }).isVisible(), true);
      await oneH1(page, "confirm");
      assert.deepEqual(problems, []);
    });
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
  test("a malformed token never reaches the API: straight to «notfound»", async () => {
    await run({ get: () => ok(INFO) }, async ({ page, state, calls }) => {
      await state("notfound").waitFor({ state: "visible" });
      assert.equal(calls.length, 0);
      await assertOnlyState(page, "notfound");
    }, { path: "/book/cancel/not-a-token" });
  });

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
// The status answer alone decides (never the booking source): offerChoice -> radios; linked -> status + «Повернутися до SMS»; otherwise nothing.
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
      await page.waitForTimeout(400);
      const cls = await page.evaluate(() => window.__cls);
      console.log("cancel page CLS (confirm + block):", cls);
      assert.ok(cls <= 0.005, `CLS ${cls}`);
      assert.equal(await page.locator("#done-reminders .seg[role=group] input[type=radio][name=reminder-channel]").count(), 2);
      assert.equal(await page.locator("#done-reminders input[value=sms]").isChecked(), true);
      const box = await page.locator("#done-reminders label:has(input[value=telegram])").boundingBox();
      assert.ok(box && box.width > 0 && box.height >= 48, "segment is a 48 px target");
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

  test("linked:true shows the Telegram status + «Повернутися до SMS»; the unlink POST returns the choice; axe clean", async () => {
    await run(tgApi({ status: { status: 200, json: { available: true, linked: true, offerChoice: false } }, unlink: { status: 204 } }), async ({ page, state, calls }) => {
      await state("confirm").waitFor({ state: "visible" });
      await block(page).waitFor({ state: "visible" });
      assert.equal(await page.getByText(r.linked).isVisible(), true);
      await page.waitForTimeout(400);
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
        await page.waitForTimeout(400);
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
      await page.waitForTimeout(300);
      assert.equal(await block(page).isVisible(), false);
      assert.equal(await page.getByRole("button", { name: c.confirm }).isVisible(), true);
    });
  });

  test("closed, unknown and malformed tokens never show the block and never call /book/telegram/status", async () => {
    const offer = tgApi({ status: STATUS({ offerChoice: true }) });
    await run({ ...offer, get: () => ok({ ...INFO, cancellable: false }) }, async ({ page, state, calls }) => {
      await state("closed").waitFor({ state: "visible" });
      await page.waitForTimeout(400);
      assert.equal(await block(page).isVisible(), false);
      assert.equal(calls.telegram.length, 0, "closed: no status call");
      assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, "closed: CLS");
    }, { init: CLS, height: 640 });
    await run({ ...offer, get: () => ({ status: 404 }) }, async ({ page, state, calls, problems }) => {
      await state("notfound").waitFor({ state: "visible" });
      await page.waitForTimeout(400);
      assert.equal(calls.telegram.length, 0, "unknown / used: no status call");
      assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, "notfound: CLS");
      expected(problems, /status of 404/); // the lookup's own 404 is the only console noise
      assert.equal(problems.filter((p) => /telegram/.test(p)).length, 0);
    }, { init: CLS, height: 640 });
    await run(offer, async ({ page, state, calls }) => {
      await state("notfound").waitFor({ state: "visible" });
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
        assert.equal((await page.locator("#r-master").innerText()).trim(), INFO.masterName);
        assert.equal((await page.locator("#r-service").innerText()).trim(), INFO.serviceName);
        assert.match(await page.locator("#r-when").innerText(), /5 березня/);
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
        assert.equal(await page.locator(`#${p}-salon-row`).isVisible(), true);
        assert.equal(await page.locator(`#${p}-address-row`).isVisible(), true);
        assert.equal((await page.locator(`#${p}-salon-row dt`).innerText()).trim(), c.salon);
        assert.equal((await page.locator(`#${p}-address-row dt`).innerText()).trim(), c.address);
        assert.equal((await page.locator(`#${p}-salon`).innerText()).trim(), "Beauty Room");
        assert.equal((await page.locator(`#${p}-address`).innerText()).trim(), "Київ, вул. Хрещатик, 1");
      });
    });

    test(`${st}: null, blank or absent values leave both rows hidden`, async () => {
      for (const body of [{ salonName: null, address: null }, { salonName: "  ", address: "" }, {}]) {
        await run({ get: () => ok({ ...INFO, ...extra, ...body }) }, async ({ page, state }) => {
          await state(st).waitFor({ state: "visible" });
          assert.equal(await page.locator(`#${p}-salon-row`).isVisible(), false);
          assert.equal(await page.locator(`#${p}-address-row`).isVisible(), false);
          assert.equal(await page.getByText(c.salon, { exact: true }).count() === 0 || !(await page.getByText(c.salon, { exact: true }).first().isVisible()), true);
        });
      }
    });

    test(`${st}: an HTML-looking value is rendered as text, never as markup`, async () => {
      const evil = '<img src=x onerror="window.__pwn=1"><b>Салон</b>';
      await run({ get: () => ok({ ...INFO, ...extra, salonName: evil, address: "<script>window.__pwn=1</script>" }) }, async ({ page, state }) => {
        await state(st).waitFor({ state: "visible" });
        assert.equal((await page.locator(`#${p}-salon`).innerText()).trim(), evil);
        assert.equal((await page.locator(`#${p}-address`).innerText()).trim(), "<script>window.__pwn=1</script>");
        assert.equal(await page.locator(`#${p}-salon *, #${p}-address *`).count(), 0, "no child elements were created");
        assert.equal(await page.evaluate(() => window.__pwn), undefined);
      });
    });
  }

  test("the read-only view with salon and address rows has no axe violations at 360 px, with the rebook link", async () => {
    await run({ get: () => ok({ ...INFO, cancellable: false, status: "COMPLETED", rebookPath: "/book/olena-koval", salonName: "Beauty Room", address: "Київ, вул. Хрещатик, 1" }) }, async ({ page, state }) => {
      await state("readonly").waitFor({ state: "visible" });
      assert.equal(await page.locator("#r-salon-row").isVisible(), true, "salon row shown");
      assert.equal(await page.locator("#r-address-row").isVisible(), true, "address row shown");
      assert.equal(await page.getByRole("link", { name: c.rebook }).isVisible(), true, "rebook shown");
      assert.deepEqual(await axeViolations(page), []);
    });
  });
});
