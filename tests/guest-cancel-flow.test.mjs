// Guest cancel page /book/cancel/{token} (src/pages/l/cancel.astro + src/lib/guestCancel.ts) against a mocked
// https://api.beautica.app: every state, one POST on double click, retry, no token leakage, CSP lets the API through.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, open, mockCancelApi } from "./helpers/browser.mjs";
import { BASE, API_ORIGIN, TOKEN, uk, requireBase } from "./helpers/env.mjs";

requireBase();
const c = uk.cancel;
const PATH = `/book/cancel/${TOKEN}`;
const API_PATH = `/api/v1/book/cancel/${TOKEN}`;
const INFO = { masterName: "Олена Коваль", serviceName: "Манікюр з покриттям", startsAt: "2030-03-05T10:00:00Z", cancellable: true, windowClosesAt: "2030-03-05T08:00:00Z" };
const ok = (json) => ({ status: 200, json });
const ALL_STATES = ["loading", "confirm", "cancelled", "closed", "notfound", "error"];

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

async function run(handlers, fn, { path = PATH, ...opts } = {}) {
  const env = await open(browser, { width: 360, height: 800, ...opts });
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
      assert.equal(await focusedId(page), "st-confirm", "focus moves to the state heading block");
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
      assert.equal(await focusedId(page), "st-closed");
    });
  });

  for (const [status, st] of [[422, "closed"], [404, "notfound"], [400, "notfound"], [500, "error"], [503, "error"], [429, "error"]]) {
    test(`GET ${status} shows «${st}»`, async () => {
      await run({ get: () => ({ status }) }, async ({ page, state, problems }) => {
        await state(st).waitFor({ state: "visible" });
        await assertOnlyState(page, st);
        assert.equal(await focusedId(page), `st-${st}`);
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
      assert.equal(await focusedId(page), "st-cancelled");
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
      assert.deepEqual(referers, []);
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
