// Phase 009 / 025, part 2 of 2 (part 1 = booking-flow.test.mjs): navigation + privacy audit, no-JS, widths, app parity, control characters, unknown-outcome cycles.
// Same browser + mock backend as part 1.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, visibleBox } from "./helpers/browser.mjs";
import { BASE, MOCK_API } from "./helpers/env.mjs";
import { bookPage, mockLog, callsTo, driveTo, fillContact, pickableDay, shot, toggleConsent, SVC_ID } from "./helpers/book.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";
import { UMAMI_SCRIPT_SRC, UMAMI_HOST_URL, CF_BEACON_SRC } from "../src/config/analytics.mjs";

let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const visibleScreen = (page) => page.locator("[data-screen]:not([hidden])").getAttribute("data-screen");
const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());
async function withPage(slug, opts, fn) {
  const env = await bookPage(browser, slug, opts);
  try {
    await fn(env);
    const blocked = opts.turnstile === "blocked" ? /net::ERR_FAILED/ : /^$/; // the blocked Turnstile script logs a failed load
    assert.deepEqual(env.problems.filter((p) => !/status of (409|401|429|503|400)/.test(p) && !blocked.test(p)), [], "no console / page errors");
    assert.deepEqual(env.external.filter((u) => !u.startsWith("https://challenges.cloudflare.com")), [], "no unexpected origin");
  } finally {
    await env.context.close();
  }
}

describe("navigation, focus, privacy", () => {
  test("the URL never changes; the browser back button walks the steps and ends on the profile", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      const url = page.url();
      await driveTo(page, "time");
      assert.equal(page.url(), url);
      assert.equal(await visibleScreen(page), "time");
      await page.goBack();
      assert.equal(await visibleScreen(page), "date");
      await page.goBack();
      assert.equal(await visibleScreen(page), "services");
      await page.goBack();
      assert.equal(await visibleScreen(page), "profile");
      await page.goForward();
      assert.equal(await visibleScreen(page), "services");
      await page.click("[data-screen=services] [data-back]");
      assert.equal(await visibleScreen(page), "profile");
      assert.equal(page.url(), url);
    });
  });

  test("after a finished booking the back button cannot reach a step that could submit again", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "НазадПісля" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      await page.goBack();
      assert.equal(await visibleScreen(page), "done");
      assert.equal(callsTo(await mockLog((e) => e.body?.name === "НазадПісля"), "POST", "/booking").length, 1);
    });
  });

  test("each step moves focus to its heading (announced by screen readers); the heading is not a link target", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.click("#book-cta");
      for (const [screen, title] of [["services", "Оберіть послуги"]]) {
        assert.equal(await text(page.locator(`[data-screen=${screen}] [data-step-heading]`)), title);
        assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-step-heading")), true);
      }
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), "Оберіть дату");
    });
  });

  test("privacy audit: no name, phone, token or code in storage, cookies, URLs or analytics; nothing else is requested", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      // Both analytics scripts are answered locally (no network); the Umami stub also "sends" every tracked event to the gateway, which is answered locally too,
      // so the whole analytics payload can be inspected. Registered after bookPage's routes: the latest route wins.
      const UMAMI_STUB = `window.umami={track:function(e,p){fetch(${JSON.stringify(UMAMI_HOST_URL + "/api/send")},{method:"POST",mode:"no-cors",body:JSON.stringify({name:e,data:p||null,url:location.href,referrer:document.referrer})});}};`;
      const sends = [];
      await context.route(`${UMAMI_HOST_URL}/**`, (r) => {
        sends.push({ url: r.request().url(), post: r.request().postData() });
        return r.fulfill({ status: 200, body: "ok" });
      });
      await context.route(UMAMI_SCRIPT_SRC, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: UMAMI_STUB }));
      const reqs = [];
      page.on("request", (r) => reqs.push({ url: r.url(), method: r.method(), post: r.postData() }));
      await driveTo(page, "confirm", { contact: { name: "Приватність", surname: "Тестова", phone: "671234567" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      await page.waitForFunction(() => typeof window.umami === "object", null, { timeout: 8000 }); // the tags are injected 1.5 s after load
      await page.waitForTimeout(300);
      const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie, h: history.state, u: location.href, n: window.name }));
      const SECRETS = ["Приватність", "Тестова", "671234567", "+380671234567", "guest-token", "123456", "TOKEN-"];
      for (const secret of SECRETS) assert.equal(stored.includes(secret), false, `${secret} leaked into storage/cookie/history/url`);
      assert.deepEqual(JSON.parse(stored).l, {});
      assert.deepEqual(JSON.parse(stored).s, {});
      const ANALYTICS_ORIGINS = [new URL(UMAMI_SCRIPT_SRC).origin, new URL(CF_BEACON_SRC).origin, new URL(UMAMI_HOST_URL).origin];
      for (const r of reqs) {
        assert.equal(/Приватність|Тестова|671234567|guest-token|%D0%9F/.test(decodeURIComponent(r.url)), false, `PII in URL ${r.url}`);
        const origin = new URL(r.url).origin;
        assert.ok([BASE, MOCK_API, "https://media.beautica.test", "https://challenges.cloudflare.com", ...ANALYTICS_ORIGINS].includes(origin), `unexpected origin ${origin}`);
        if (ANALYTICS_ORIGINS.includes(origin)) assert.ok(r.url === UMAMI_SCRIPT_SRC || r.url === CF_BEACON_SRC || r.url === `${UMAMI_HOST_URL}/api/send`, `unexpected analytics URL ${r.url}`);
      }
      // Exactly the two documented script URLs, and every analytics request (script URL, query, payload) is free of anything personal.
      assert.deepEqual([...new Set(reqs.map((r) => r.url).filter((u) => /\.(umami|cloudflareinsights)\.|umami\.is/.test(u) && !u.startsWith(UMAMI_HOST_URL)))].sort(), [CF_BEACON_SRC, UMAMI_SCRIPT_SRC].sort());
      assert.ok(sends.length > 0, "the stub saw at least one event, so the payload check below is not vacuous");
      for (const a of [...reqs.filter((r) => ANALYTICS_ORIGINS.includes(new URL(r.url).origin)), ...sends]) {
        const blob = decodeURIComponent(`${a.url} ${a.post ?? ""}`);
        for (const secret of SECRETS) assert.equal(blob.includes(secret), false, `${secret} leaked into an analytics request ${a.url}`);
        assert.equal(/\+?380\d{9}|\b\d{6}\b|token/i.test(blob), false, `phone/code/token-shaped value in an analytics request ${a.url}`);
        assert.equal(new URL(a.url).search, "", `analytics URL carries a query: ${a.url}`);
      }
      const posts = reqs.filter((r) => r.method === "POST" && !r.url.startsWith(UMAMI_HOST_URL)).map((r) => new URL(r.url).pathname);
      assert.deepEqual(posts.filter((p) => !/\/book\/(otp\/(send|verify)|oksana-ab12\/booking)$/.test(p)), []);
    });
  });

  test("every request to the API is credential-less and sends no cookies", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "БезКукі", phone: "671234500" } });
      const log = await mockLog((e) => e.path.includes("oksana-ab12") || e.body?.phone === "+380671234500");
      assert.ok(log.length >= 3);
      for (const e of log) assert.equal(e.headers.cookie, undefined, e.path);
    });
  });
});

describe("no JavaScript", () => {
  test("the profile and services stay readable; the page says booking needs JavaScript or the app", async () => {
    await withPage("oksana-ab12", { js: false }, async ({ page }) => {
      await page.locator("[data-panel='1'] summary").first().click(); // the category accordions are native <details>: they open without script
      const body = (await text(page.locator("body"))).replace(/\s+/g, " ");
      assert.ok(await page.locator("[data-panel='1'] .stile").first().isVisible(), "a service is readable after opening its category");
      for (const s of ["Оксана Коваленко", "Манікюр класичний", "від 450 ₴", "Марина К."]) assert.ok(body.includes(s.replace(/ /g, " ")) || body.includes(s), s);
      assert.ok(body.includes("увімкніть JavaScript"));
      assert.equal(await page.locator("#book-cta").isVisible(), false);
      assert.equal(await page.locator("[data-screen=services]").isVisible(), false);
    });
  });
});

describe("every step renders on phone, tablet and desktop", () => {
  for (const width of [360, 768, 1280]) {
    test(`@${width}: each screen has no horizontal scroll, drawn parts have a box, controls are >= 48 px, one column <= 420 px`, async () => {
      await withPage("salonmaster-5555", { width }, async ({ page }) => {
        const seen = [];
        const check = async (label, boxes = []) => {
          seen.push(label);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          assert.ok(overflow <= 0, `${label}: horizontal scroll ${overflow}px`);
          // Polled, not read once: the calendar re-renders its buttons when the bookable-days answer lands (renderCalendar replaces the grid children), and a
          // boundingBox() read in that instant finds the old, detached button (null). A part that really has no box still fails once the poll runs out.
          for (const sel of boxes) {
            const part = page.locator(`[data-screen]:not([hidden]) ${sel}`).first();
            let drawn = await visibleBox(part);
            for (let i = 0; !drawn && i < 40; i++) {
              await page.waitForTimeout(50);
              drawn = await visibleBox(part);
            }
            assert.ok(drawn, `${label}: ${sel} has no box`);
          }
          const small = await page.evaluate(() =>
            [...document.querySelectorAll("[data-screen]:not([hidden]) :is(a[href], button, input:not([type=checkbox]), textarea)")]
              .filter((e) => !e.closest("[hidden]") && getComputedStyle(e).visibility !== "hidden" && !e.matches(".chk-row a")) // the privacy link is a text link inside a sentence (WCAG 2.5.8 inline exception)
              .map((e) => ({ t: e.tagName + "." + e.className + "#" + e.id, b: e.getBoundingClientRect() }))
              .filter(({ b }) => b.width > 0 && b.height > 0 && (b.height < 48 || b.width < 48))
              .map(({ t, b }) => `${t} ${Math.round(b.width)}x${Math.round(b.height)}`),
          );
          assert.deepEqual(small, [], `${label}: controls under 48 px`);
          // The one code input overlays all six cells: a tap on any cell hits it.
          const cellHits = await page.evaluate(() =>
            [...document.querySelectorAll("[data-screen]:not([hidden]) #otp .otp-cell")].map((c) => {
              const b = c.getBoundingClientRect();
              return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.id === "otp-input";
            }),
          );
          assert.ok((cellHits.length === 0 || cellHits.length === 6) && cellHits.every(Boolean), `${label}: the code input covers every cell`);
          assert.ok((await page.locator(".phone").boundingBox()).width <= 420);
          await shot(page, `flow-${label}-${width}`);
        };
        await page.click("#book-cta");
        await check("services", [".strip", ".stile", ".shelf .cta"]);
        await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
        await page.click(`#svc-list [data-id="${SVC_ID.gel}"]`);
        await page.click("[data-sb='services'] .labelrow");
        await check("services-picked", [".chk", ".sel-entry"]);
        await page.click("#cta-services");
        await check("date", [".cal-grid", ".dbtn", ".chevbtn"]);
        await page.click(`[data-day="${await pickableDay(page)}"]`);
        await page.click("#cta-date");
        await page.waitForSelector("#slots .slot");
        await check("time", [".slot", ".sgroup-label"]);
        await page.locator("#slots .slot").nth(1).click();
        await page.click("#cta-time");
        await check("contact", ["#name", "#phone", ".chk", ".cta"]);
        await page.click("#cta-contact");
        await check("contact-errors", [".ferr"]);
        await fillContact(page, { name: "Ширина", phone: "671230000" });
        await page.click("#cta-contact");
        await page.waitForSelector("#otp", { state: "visible" });
        await check("otp", ["#otp input", ".mail-tile"]);
        await page.locator("#otp input").fill("123456");
        await page.waitForSelector("#confirm-card", { state: "visible" });
        await check("confirm", ["#confirm-card", ".strip", ".footer .cta"]);
        await page.click("#cta-confirm");
        await page.waitForSelector("#done-card", { state: "visible" });
        await check("done", [".hero .disc", "#done-card", ".calbtn"]);
        assert.equal(seen.length, 9);
      });
    });
  }
});

describe("parity with the app: category accordions, comment, address (backend 383 + 385)", () => {
  test("services step: category accordions with the app's count badge and a live «selected» badge", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])"); // the island loads on the tap
      const names = await page.locator("#svc-list [data-cat-group] .lbl").allInnerTexts();
      assert.deepEqual(names, ["Нігтьовий сервіс", "Подологія", "Оформлення брів"]);
      assert.deepEqual(await page.locator("#svc-list [data-cat-group] .badge:not(.sel)").allInnerTexts(), ["2", "1", "1"]);
      const sel = page.locator("#svc-list [data-cat-group]").first().locator("[data-sel-badge]");
      assert.equal(await sel.isVisible(), false);
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click(`#svc-list [data-id="${SVC_ID.gel}"]`);
      assert.equal(await sel.isVisible(), true);
      assert.equal(await text(sel), "2");
      await page.click(`#svc-list [data-id="${SVC_ID.gel}"]`);
      assert.equal(await text(sel), "1");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      assert.equal(await sel.isVisible(), false, "the badge hides at zero");
      await page.locator("#svc-list summary").nth(1).click();
      assert.equal(await page.locator(`#svc-list [data-id="${SVC_ID.pedi}"]`).isVisible(), false, "a collapsed group hides its tiles");
    });
  });

  test("confirm: optional «Коментар для майстра»: 2-row textarea, 500 as in the app, 16 px, no counter", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Коментар" } });
      assert.equal(await page.getAttribute("#comment", "maxlength"), "500", "the app's limit (booking_confirm_screen _maxComment)");
      assert.equal(await page.getAttribute("#comment", "placeholder"), "Необов'язково");
      assert.equal(await page.getAttribute("#comment", "rows"), "2");
      assert.equal(await page.locator("#counter, [data-counter]").count(), 0, "the counter is gone");
      assert.equal(await page.locator("#comment").evaluate((e) => getComputedStyle(e).fontSize), "16px", "16 px: iOS Safari does not zoom in");
      assert.ok((await text(page.locator("[data-screen=confirm]"))).includes("Коментар для майстра"));
      assert.equal(await page.locator("[data-screen=confirm] textarea").count(), 1);
    });
  });

  test("a comment is sent trimmed as clientComment (kept in its field, not repeated in the summary); blank is omitted; never in the done recap", async () => {
    for (const [name, comment] of [["КоментарТак", "  Прийду з дитиною\nдякую  "], ["КоментарНі", "   "]]) {
      await withPage("oksana-ab12", {}, async ({ page }) => {
        await driveTo(page, "time");
        await page.click("#cta-time");
        await fillContact(page, { name });
        await page.click("#cta-contact");
        await page.waitForSelector("#otp", { state: "visible" });
        await page.locator("#otp input").fill("123456");
        await page.waitForSelector("#confirm-card", { state: "visible" });
        await page.fill("#comment", comment);
        const recap = await text(page.locator("#confirm-card"));
        assert.equal(recap.includes("Прийду"), false, "the summary card does not repeat the comment (it stays in its field)");
        await page.click("#cta-confirm");
        await page.waitForSelector("#done-card", { state: "visible" });
        assert.equal((await text(page.locator("#done-card"))).includes("Прийду"), false);
        const booking = callsTo(await mockLog((e) => e.body?.name === name), "POST", "/booking").at(-1);
        if (name === "КоментарТак") assert.equal(booking.body.clientComment, "Прийду з дитиною\nдякую");
        else assert.equal("clientComment" in booking.body, false, "a blank comment is omitted");
        assert.equal(JSON.stringify(await page.evaluate(() => ({ ...localStorage, ...sessionStorage, u: location.href }))).includes("дитиною"), false, "never stored or in the URL");
      });
    }
  });

  test("a comment the backend rejects (over 1000 chars, 400) shows the generic fix-it message, no double booking", async () => {
    for (const bad of ["я".repeat(1001)]) { // control characters never get this far any more: they are stripped as typed (see below)
      await withPage("oksana-ab12", {}, async ({ page }) => {
        await driveTo(page, "confirm", { contact: { name: "Поганий" } });
        await page.locator("#comment").evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, bad); // bypasses maxlength like a pasted value
        await page.click("#cta-confirm");
        await page.waitForSelector("#submit-error", { state: "visible" });
        assert.ok((await text(page.locator("#submit-error"))).includes("Перевірте дані запису"));
        assert.equal(await page.locator("#cta-confirm").isEnabled(), true);
        assert.equal(await visibleScreen(page), "confirm");
      });
    }
    const direct = await fetch(`${MOCK_API}/api/v1/book/oksana-ab12/booking`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer guest-token-ok" }, body: JSON.stringify({ serviceId: SVC_ID.classic, startsAt: "2030-01-01T10:00:00+02:00", name: "а", surname: "б", privacyAccepted: true, privacyPolicyVersion: "2026-10-22", clientComment: "x".repeat(1001) }) });
    assert.equal(direct.status, 400);
    const ok = await fetch(`${MOCK_API}/api/v1/book/oksana-ab12/booking`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer guest-token-ok" }, body: JSON.stringify({ serviceId: SVC_ID.classic, startsAt: "2030-01-01T10:00:00+02:00", name: "а", surname: "б", privacyAccepted: true, privacyPolicyVersion: "2026-10-22", clientComment: "x".repeat(1000) + "" }) });
    assert.equal(ok.status, 201, "exactly 1000 is allowed");
  });

  test("confirm: an independent master's «Адреса» row (street, building, city) with the note below; a salon master shows «Салон» and no address", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Адреса" } });
      const recap = await text(page.locator("#confirm-card"));
      assert.ok(recap.includes("Адреса Київ, вул. Хрещатик, 22 2 поверх, офіс 5"), recap);
      assert.equal(recap.includes("Місто"), false);
    });
    await withPage("salonmaster-5555", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "СалонАдреса" } });
      const recap = await text(page.locator("#confirm-card"));
      assert.ok(recap.includes("Салон «Лаванда»") && recap.includes("Місто Київ") && !recap.includes("Адреса"), recap);
    });
  });
});

describe("control characters in guest text", () => {
  test("a pasted tab is cleaned in the field and a name of only control characters is rejected inline BEFORE the SMS code is requested", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await page.locator("#name").evaluate((el) => { el.value = "Мар\tина\u0007"; el.dispatchEvent(new Event("input", { bubbles: true })); });
      assert.equal(await page.inputValue("#name"), "Мар ина ", "controls became one space (a trailing one stays while typing, it is trimmed when sent)");
      await page.locator("#surname").evaluate((el) => { el.value = "\t\t"; el.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.type("#phone", "671119900");
      await page.locator("#f-consent").click({ position: { x: 14, y: 14 } });
      const before = (await mockLog((e) => e.path.includes("/otp/send") && e.body?.phone === "+380671119900")).length;
      await page.click("#cta-contact");
      assert.ok((await text(page.locator("#f-surname .ferr"))).includes("Це поле обов'язкове"), "the surname of only tabs is required");
      assert.equal((await mockLog((e) => e.path.includes("/otp/send") && e.body?.phone === "+380671119900")).length, before, "no SMS was requested");
    });
  });

  test("the booking sends the cleaned names and comment (no control characters, comment keeps its line break)", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await page.locator("#name").evaluate((el) => { el.value = "Ірина\u0009Марія"; el.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.locator("#surname").evaluate((el) => { el.value = "Ко\u001Fвальчук"; el.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.type("#phone", "671119901");
      await page.locator("#f-consent").click({ position: { x: 14, y: 14 } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.locator("#otp input").fill("123456");
      await page.waitForSelector("#confirm-card", { state: "visible" });
      await page.locator("#comment").evaluate((el) => { el.value = "а\u0007б\nв"; el.dispatchEvent(new Event("input", { bubbles: true })); });
      assert.equal(await page.inputValue("#comment"), "аб\nв");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const b = callsTo(await mockLog((e) => e.body?.name === "Ірина Марія"), "POST", "/booking").at(-1);
      assert.equal(b.body.name, "Ірина Марія");
      assert.equal(b.body.surname, "Ко вальчук");
      assert.equal(b.body.clientComment, "аб\nв");
    });
  });
});

describe("audit cycle 2: a booking of unknown outcome, and the caches (master link)", () => {
  const MSG = /Не вдалося підтвердити запис до Оксана Коваленко\. Перевірте SMS або посилання для скасування, перш ніж записуватися ще раз\./;
  const okProblems = (env) => assert.deepEqual(env.problems.filter((p) => !/status of (409|401|429|503|400|504|500)|net::ERR_FAILED/.test(p)), [], "no console / page errors");
  /** The backend books, then the answer is lost (`how` = "drop") or turned into a gateway timeout ("504"), once. */
  async function lostAnswer(env, slug, how) {
    let done = false;
    await env.context.route(`${MOCK_API}/api/v1/book/${slug}/booking`, async (route) => {
      if (done) return route.fallback();
      done = true;
      await route.fetch();
      return how === "drop" ? route.abort("failed") : route.fulfill({ status: 504, contentType: "text/plain", body: "gateway timeout" });
    });
  }
  for (const [how, slug] of [["drop", "ambig-0001"], ["504", "ambig-504a"]])
    test(`${how === "drop" ? "the answer is dropped" : "a gateway timeout (504)"} after the backend booked: only the SAME slot can be sent again, no date/time step is reachable, the fields freeze`, async () => {
      const env = await bookPage(browser, slug);
      try {
        const { page } = env;
        await lostAnswer(env, slug, how);
        await driveTo(page, "confirm");
        await page.click("#cta-confirm");
        await page.locator("#submit-error:not([hidden])").waitFor();
        assert.match(await text(page.locator("#submit-error")), MSG);
        assert.equal(await page.locator("[data-screen=confirm] [data-back]").isHidden(), true, "no back arrow");
        assert.equal(await page.locator("#phone").evaluate((e) => e.readOnly), true);
        assert.equal(await page.locator("#comment").evaluate((e) => e.readOnly), true);
        assert.equal(await text(page.locator("#cta-confirm")), "Спробувати знову");
        await page.goBack();
        assert.equal(await visibleScreen(page), "confirm", "Back cannot reach the time or date step");
        await page.click("#cta-confirm"); // the same slot again: taken (by the lost request) -> «probably booked by you»
        await page.waitForFunction(() => !document.querySelector("#cta-confirm").disabled);
        assert.match(await text(page.locator("#submit-error")), MSG);
        assert.equal(await visibleScreen(page), "confirm", "a 409 after an uncertain attempt does not send the guest to pick another time");
        const posts = callsTo(await mockLog(), "POST", `/book/${slug}/booking`);
        assert.equal(posts.length, 2);
        assert.equal(posts[0].body.startsAt, posts[1].body.startsAt, "never another time");
        okProblems(env);
      } finally {
        await env.context.close();
      }
    });
  test("a free-times list is refetched once its minute is over, and the fresh answer replaces the old one", async () => {
    const env = await bookPage(browser, "slotc-0001", { init: () => { window.__skew = 0; const now = Date.now.bind(Date); Date.now = () => now() + window.__skew; } });
    try {
      const { page } = env;
      await driveTo(page, "time");
      const count = async () => callsTo(await mockLog(), "GET", "/book/slotc-0001/availability").length;
      assert.equal(await count(), 1);
      await page.goBack();
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      assert.equal(await count(), 1, "within the minute: from the cache");
      await page.evaluate(() => (window.__skew = 61000));
      await page.goBack();
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      assert.equal(await count(), 2, "expired: refetched");
      await page.goBack();
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      assert.equal(await count(), 2, "the refetched answer is cached again (an expired entry is replaced, not kept)");
      okProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a failed bookable-days request is not remembered: coming back to the month asks again", async () => {
    const env = await bookPage(browser, "daysr-0001");
    try {
      const { page } = env;
      let n = 0;
      await env.context.route(`${MOCK_API}/api/v1/book/daysr-0001/bookable-days*`, (route) => (++n === 1 ? route.fulfill({ status: 500, body: "boom" }) : route.fallback()));
      await driveTo(page, "services");
      await page.click("#cta-services");
      await page.waitForSelector(".dbtn");
      await page.waitForTimeout(300);
      await page.goBack();
      await page.click("#cta-services");
      await page.waitForFunction(() => [...document.querySelectorAll(".dbtn")].some((b) => b.disabled && new Date(`${b.dataset.day}T12:00:00Z`).getUTCDay() === 0 && b.dataset.day >= document.querySelector(".dbtn.today").dataset.day));
      assert.equal(n, 2, "asked again after the failure");
      okProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("audit cycle 3: a booking of unknown outcome survives a reload (sessionStorage marker, no personal data)", () => {
  const KEY = (slug) => `bk-unsure:master:${slug}`;
  const NOTICE = /Можливо, ви вже записані на .+\. Перевірте SMS перед новим записом\./;
  const okProblems = (env) => assert.deepEqual(env.problems.filter((p) => !/status of (409|401|429|503|400|504)|net::ERR_FAILED/.test(p)), [], "no console / page errors");
  const stored = (page, slug) => page.evaluate((k) => sessionStorage.getItem(k), KEY(slug));
  /** The backend books and the answer becomes a 504 (once). `commit: false`: the request never reaches the backend (a dropped connection). */
  async function lose(env, slug, { commit = true } = {}) {
    let done = false;
    await env.context.route(`${MOCK_API}/api/v1/book/${slug}/booking`, async (route) => {
      if (done) return route.fallback();
      done = true;
      if (commit) {
        await route.fetch();
        return route.fulfill({ status: 504, contentType: "text/plain", body: "gateway timeout" });
      }
      return route.abort("failed");
    });
  }
  test("after a 504 the marker holds the slot, a time label and a timestamp, nothing personal; a reload shows the notice, «Зрозуміло» clears it", async () => {
    const slug = "ambig-5041";
    const env = await bookPage(browser, slug);
    try {
      const { page } = env;
      await lose(env, slug);
      await driveTo(page, "confirm", { contact: { name: "Іванна", surname: "Тестова" }, code: "654321" });
      await page.fill("#comment", "Секретна нотатка");
      await page.click("#cta-confirm");
      await page.locator("#submit-error:not([hidden])").waitFor();
      const raw = await stored(page, slug);
      const m = JSON.parse(raw);
      assert.deepEqual(Object.keys(m).sort(), ["at", "label", "slotStartIso"]);
      assert.ok(Math.abs((await page.evaluate(() => Date.now())) - m.at) < 60_000 && // the browser's clock (bookPage fixes it at TEST_NOW), not node's
         /T\d\d:\d\d/.test(m.slotStartIso));
      for (const secret of ["501234567", "+380", "Іванна", "Тестова", "Секретна", "guest-token", "123456", "654321"]) assert.equal(raw.includes(secret), false, `the marker must not contain «${secret}»`);
      await page.reload({ waitUntil: "load" });
      await page.locator("#unsure-note").waitFor();
      assert.match(await text(page.locator("#unsure-note")), NOTICE);
      assert.equal(await page.locator("#unsure-note [role=button], #unsure-note button").count(), 1);
      await page.getByRole("button", { name: "Зрозуміло" }).click();
      assert.equal(await page.locator("#unsure-note").count(), 0);
      assert.equal(await stored(page, slug), null, "dismissing clears the marker");
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(300);
      assert.equal(await page.locator("#unsure-note").count(), 0);
      okProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a confirmed booking clears the marker (a dropped request, then the same slot goes through)", async () => {
    const slug = "ambig-5042";
    const env = await bookPage(browser, slug);
    try {
      const { page } = env;
      await lose(env, slug, { commit: false });
      await driveTo(page, "confirm");
      await page.click("#cta-confirm");
      await page.locator("#submit-error:not([hidden])").waitFor();
      assert.ok(await stored(page, slug), "the marker is there after the lost request");
      await page.waitForFunction(() => !document.querySelector("#cta-confirm").disabled);
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.equal(await stored(page, slug), null, "success removes the marker");
      okProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a marker older than 15 minutes shows nothing and is removed; a fresh one shows the notice (so the first check bites)", async () => {
    const slug = "ambig-5043";
    for (const [age, shown] of [[16 * 60_000, false], [60_000, true]]) {
      const env = await bookPage(browser, slug, { init: `try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); sessionStorage.setItem(${JSON.stringify(KEY(slug))}, JSON.stringify({ slotStartIso: "2030-01-02T10:00:00+02:00", label: "вівторок, 2 січня, 10:00", at: Date.now() - ${age} })); } } catch {}` });
      try {
        const { page } = env;
        await page.reload({ waitUntil: "load" }); // the marker was written by the init script of the first load
        await page.waitForTimeout(300);
        assert.equal(await page.locator("#unsure-note").count(), shown ? 1 : 0, `age ${age / 60000} min`);
        if (!shown) assert.equal(await stored(page, slug), null, "an expired marker is removed");
        okProblems(env);
      } finally {
        await env.context.close();
      }
    }
  });
  test("with storage blocked the page and the booking button still work", async () => {
    const env = await bookPage(browser, "store-0001", { init: `Object.defineProperty(window, "sessionStorage", { get() { throw new Error("blocked"); } });` });
    try {
      const { page } = env;
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      assert.equal(await page.locator("#unsure-note").count(), 0);
      okProblems(env);
    } finally {
      await env.context.close();
    }
  });
  const seed = (slug, extra = "") => `try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); sessionStorage.setItem(${JSON.stringify(KEY(slug))}, JSON.stringify({ slotStartIso: "2030-01-02T10:00:00+02:00", label: "вівторок, 2 січня, 10:00", at: Date.now() - 60000${extra} })); } } catch {}`;
  const CLS = `window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });`;
  test("the notice is laid over the page: it adds no layout shift at 360, 768 and 1280 px (budget 0.005)", async () => {
    for (const width of [360, 768, 1280]) {
      const env = await bookPage(browser, "ambig-5043", { width, init: CLS + seed("ambig-5043") });
      try {
        const { page } = env;
        await page.locator("#unsure-note").waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(300);
        const cls = await page.evaluate(() => window.__cls);
        const box = await page.locator("#unsure-note").boundingBox();
        assert.ok(cls <= 0.005, `CLS ${cls} at ${width}px`);
        assert.equal(await page.locator("#unsure-note").evaluate((e) => getComputedStyle(e).position), "fixed");
        assert.ok(box.width > 0 && box.height > 0 && box.height <= 80 && box.x >= 0 && box.x + box.width <= width, `the toast is ${box.width}x${box.height} at x=${box.x} (${width}px)`);
        okProblems(env);
      } finally {
        await env.context.close();
      }
    }
  });
  test("the salon page too: the notice adds no layout shift at 360, 768 and 1280 px (budget 0.005)", async () => {
    const slug = "lavanda-1111";
    const salonSeed = `try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); sessionStorage.setItem("bk-unsure:salon:${slug}", JSON.stringify({ masterId: "e0000101-1111-4222-8333-944455556666", slotStartIso: "2030-01-02T10:00:00+02:00", label: "вівторок, 2 січня, 10:00, Майстер2 Тест", at: Date.now() - 60000 })); } } catch {}`;
    for (const width of [360, 768, 1280]) {
      const env = await bookPage(browser, null, { path: `/book/s/${slug}`, width, init: CLS + salonSeed });
      try {
        const { page } = env;
        await page.locator("#unsure-note").waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(300);
        const cls = await page.evaluate(() => window.__cls);
        assert.ok(cls <= 0.005, `salon CLS ${cls} at ${width}px`);
        assert.equal(await page.locator("#unsure-note").evaluate((e) => getComputedStyle(e).position), "fixed");
        okProblems(env);
      } finally {
        await env.context.close();
      }
    }
  });
  test("«Зрозуміло» moves the focus to the page heading (never to <body>)", async () => {
    const env = await bookPage(browser, "ambig-5043", { init: seed("ambig-5043") });
    try {
      const { page } = env;
      await page.locator("#unsure-note").waitFor();
      await page.getByRole("button", { name: "Зрозуміло" }).focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("#unsure-note").count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
      okProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a marker that is not ours (a 10 KB label, or a field over its cap) shows nothing and its key is removed", async () => {
    const slug = "ambig-5043";
    for (const extra of [`, label2: "x"`, ""]) {
      const label = extra ? "а".repeat(10_000) : "вівторок, 2 січня, 10:00";
      const env = await bookPage(browser, slug, {
        init: `try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); sessionStorage.setItem(${JSON.stringify(KEY(slug))}, JSON.stringify({ slotStartIso: ${extra ? '"2030-01-02T10:00:00+02:00"' : JSON.stringify("1".repeat(65))}, label: ${JSON.stringify(label)}, at: Date.now() - 1000 })); } } catch {}`,
      });
      try {
        const { page } = env;
        await page.waitForTimeout(300);
        assert.equal(await page.locator("#unsure-note").count(), 0, extra ? "10 KB label" : "65-character slot");
        assert.equal(await stored(page, slug), null, "the key is removed");
        okProblems(env);
      } finally {
        await env.context.close();
      }
    }
  });
});
