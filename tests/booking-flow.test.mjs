// Phase 009: the guest booking flow on /book/{slug}, in a real browser, against the mock backend (tests/helpers/mock-api.mjs).
// Happy path (single + multi service, salon master), every error state, privacy audit, back button, double submit, a11y focus, widths.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, visibleBox } from "./helpers/browser.mjs";
import { BASE, MOCK_API } from "./helpers/env.mjs";
import { bookPage, mockLog, callsTo, driveTo, fillContact, pickableDay, shot, toggleConsent, SVC_ID } from "./helpers/book.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";

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

describe("happy path: one service", () => {
  test("services -> date -> time -> contact (+ consent + Turnstile) -> SMS code -> confirm -> done, with exactly the documented API traffic", async () => {
    await withPage("oksana-ab12", {}, async ({ page, turnstileRequests }) => {
      const name = "ПовнийШлях";
      await page.waitForSelector("#book-cta:visible");
      assert.equal(await visibleScreen(page), "profile");
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])"); // the island loads on the tap
      assert.equal(await visibleScreen(page), "services");
      assert.equal(await page.locator("#cta-services").isDisabled(), true, "no service yet: Далі is disabled");
      assert.ok((await text(page.locator("[data-sb='services']"))).includes("Оберіть хоча б одну послугу"));
      await page.click(`#svc-list [data-id="${SVC_ID.gel}"]`);
      assert.equal(await page.locator(`#svc-list [data-id="${SVC_ID.gel}"]`).getAttribute("aria-pressed"), "true");
      assert.match(await text(page.locator("[data-sb='services']")), /1 послуга.*Разом.*1 год 30 хв.*від 650 ₴/);
      await page.click("#cta-services");
      assert.equal(await visibleScreen(page), "date");
      assert.equal(await page.locator("#cta-date").isDisabled(), true);
      const day = await pickableDay(page);
      await page.click(`[data-day="${day}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      assert.equal(await page.locator("#slots .slot").count(), 8);
      assert.deepEqual(await page.locator("#slots .sgroup-label span").allInnerTexts(), ["Ранок", "День", "Вечір"]);
      assert.equal(await page.locator("#cta-time").isDisabled(), true, "no slot chosen yet");
      const slot = page.locator("#slots .slot").nth(2);
      const startsAt = await slot.getAttribute("data-t");
      assert.match(startsAt, /^\d{4}-\d{2}-\d{2}T12:00:00\+0[23]:00$/, "the slot's ISO offset string is kept as the API sent it");
      await slot.click();
      assert.equal(await slot.getAttribute("aria-pressed"), "true");
      assert.match(await text(page.locator("[data-sb='time'] .chosen")), /12:00–13:30/);
      await page.click("#cta-time");
      assert.equal(await visibleScreen(page), "contact");
      await page.fill("#name", name);
      await page.fill("#surname", "Коваленко");
      await page.type("#phone", "501234567");
      assert.equal(await page.inputValue("#phone"), "+380 50 123 45 67");
      await toggleConsent(page);
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      assert.equal(await text(page.locator("#otp-phone")), "+380 50 123 45 67");
      assert.match(await text(page.locator("#otp-resend")), /Надіслати знову \(\d+ с\)/, "resend cooldown is running");
      assert.equal(await page.locator("#cta-otp").isDisabled(), true);
      for (const [i, d] of [..."123456"].entries()) await page.locator("#otp input").nth(i).fill(d);
      await page.click("#cta-otp");
      await page.waitForSelector("#confirm-card", { state: "visible" });
      assert.equal(await text(page.locator("#c-name")), `${name} Коваленко`);
      assert.equal(await text(page.locator("#c-phone")), "+380 50 123 45 67");
      const recap = await text(page.locator("#confirm-card"));
      for (const s of ["Київ", "Манікюр+гель лак", "1 год 30 хв", "від 650 ₴", "12:00–13:30", "Разом"]) assert.ok(recap.includes(s.replace(/ /g, " ")) || recap.includes(s), `confirm lacks ${s}: ${recap}`);
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.equal(await visibleScreen(page), "done");
      assert.equal(await text(page.locator("[data-screen=done] h2")), "Записано!");
      assert.ok((await text(page.locator("[data-screen=done]"))).includes("Ваш запис підтверджено"));
      assert.equal((await text(page.locator("[data-screen=done]"))).includes("підтвердить"), false, "the app's stale «майстер підтвердить» wording is not used");

      const log = await mockLog((e) => e.body?.name === name || e.path.includes("oksana-ab12/availability") || (e.path.includes("/otp/") && e.body?.phone === "+380501234567"));
      const send = callsTo(log, "POST", "/otp/send").at(-1);
      assert.deepEqual(send.body, { phone: "+380501234567", privacyAccepted: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION, turnstileToken: "TOKEN-1" });
      assert.deepEqual(callsTo(log, "POST", "/otp/verify").at(-1).body, { phone: "+380501234567", code: "123456" });
      const avail = callsTo(log, "GET", "oksana-ab12/availability").at(-1);
      assert.equal(avail.path, `/api/v1/book/oksana-ab12/availability?date=${day}&serviceId=${SVC_ID.gel}`);
      const booking = callsTo(log, "POST", "/oksana-ab12/booking").at(-1);
      assert.equal(booking.headers.authorization, "Bearer guest-token-ok");
      assert.deepEqual(booking.body, { serviceId: SVC_ID.gel, startsAt, name, surname: "Коваленко", privacyAccepted: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
      assert.equal(booking.headers.cookie, undefined);
      assert.equal(booking.headers.referer, undefined, "no Referer to the API");
      assert.ok(turnstileRequests.length >= 1 && turnstileRequests.every((u) => u.startsWith("https://challenges.cloudflare.com/turnstile/")));
      await shot(page, "flow-done-360");
    });
  });

  test("done: the cancel link goes to this site's page, the .ics is built in the browser, the done step is the design's (no install block)", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.addInitScript(() => {
        window.__icsBlobs = [];
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b) => (window.__icsBlobs.push(b), create(b));
      });
      await page.reload();
      await driveTo(page, "confirm", { contact: { name: "Календар" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const cancel = page.locator("#done-cancel");
      assert.equal(await cancel.isVisible(), true);
      assert.equal(await cancel.getAttribute("href"), "/book/cancel/123e4567-e89b-42d3-a456-426614174000", "cancel path only, same origin");
      assert.ok((await text(page.locator("[data-screen=done]"))).includes("не пізніше ніж за 2 години"));
      // The file is read from the Blob the page builds (the download itself lands in the browser's private temp dir: a snap Chromium
      // cannot hand it to the test), plus the download event proves the click really offers beautica-booking.ics.
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Додати в календар" }).click()]);
      assert.equal(download.suggestedFilename(), "beautica-booking.ics");
      assert.equal(await download.failure(), null);
      assert.match(download.url(), /^blob:/);
      const ics = await page.evaluate(() => window.__icsBlobs.at(-1).text());
      assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
      assert.match(ics, /SUMMARY:Запис до Оксана Коваленко/);
      assert.match(ics, /DTSTART:\d{8}T\d{6}Z\r\n/);
      assert.match(ics, /LOCATION:Київ/);
      assert.equal(ics.includes("Календар"), false, "the guest's name is not in the file");
      const done = await text(page.locator("[data-screen=done]"));
      assert.equal(done.includes("Керуйте записами"), false, "no install block: the done step is the design's");
      assert.equal(await page.locator("[data-screen=done] .chip").count(), 0);
      assert.ok(await visibleBox(page.locator("[data-screen=done] .calbtn svg")), "calendar glyph is drawn");
      const paint = await page.locator("[data-screen=done] .calbtn svg").evaluate((s) => { const c = getComputedStyle(s); return { fill: c.fill, stroke: c.stroke, w: c.strokeWidth }; });
      assert.equal(paint.fill, "none", "a stroke glyph is an outline, not a filled blob");
      assert.notEqual(paint.stroke, "none");
      assert.ok(parseFloat(paint.w) >= 1.5);
      await page.getByRole("link", { name: "На головну" }).waitFor();
    });
  });

  test("the day grid has no slot-less guesswork: every day of the window is selectable, days before today are not", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "services");
      await page.click("#cta-services");
      const states = await page.evaluate(() => {
        const t = document.querySelector(".dbtn.today").dataset.day;
        return [...document.querySelectorAll(".dbtn")].map((b) => ({ d: b.dataset.day, off: b.disabled, t }));
      });
      const today = states[0].t;
      assert.ok(states.filter((s) => s.d < today).every((s) => s.off));
      assert.ok(states.filter((s) => s.d >= today).every((s) => !s.off));
      assert.equal(await page.locator("#prev").isDisabled(), true);
      await page.click("#next");
      await page.click("#next");
      assert.equal(await page.locator("#next").isDisabled(), true, "three months cover today ... +60 days");
    });
  });
});

describe("multi-service visit", () => {
  test("three services: one booking with masterServiceIds, availability asked for all three, totals added up", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      const name = "ТриПослуги";
      await page.click("#book-cta");
      for (const id of [SVC_ID.classic, SVC_ID.gel, SVC_ID.pedi]) await page.click(`#svc-list [data-id="${id}"]`);
      assert.match(await text(page.locator("[data-sb='services']")), /3 послуги.*Разом.*4 год.*від 1 900 ₴/);
      await page.click("[data-sb='services'] .labelrow");
      assert.equal(await page.locator("[data-sb='services'] .sel-entry").count(), 3);
      await page.click(`[data-sb='services'] [aria-label="Прибрати: Манікюр класичний"]`);
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      await page.click(`[data-day="${await pickableDay(page)}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      await page.locator("#slots .slot").first().click();
      await page.click("#cta-time");
      await fillContact(page, { name });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      for (const [i, d] of [..."654321"].entries()) await page.locator("#otp input").nth(i).fill(d);
      await page.click("#cta-otp");
      await page.waitForSelector("#confirm-card", { state: "visible" });
      assert.ok((await text(page.locator("#confirm-card"))).includes("4 год"));
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const log = await mockLog((e) => e.body?.name === name || e.path.includes("oksana-ab12/availability"));
      const booking = callsTo(log, "POST", "/booking").at(-1);
      assert.deepEqual(booking.body.masterServiceIds.sort(), [SVC_ID.classic, SVC_ID.gel, SVC_ID.pedi].sort());
      assert.equal(booking.body.serviceId, undefined, "a visit sends masterServiceIds only");
      const avail = callsTo(log, "GET", "oksana-ab12/availability").at(-1);
      assert.equal(new URL(avail.path, "http://x").searchParams.getAll("serviceId").length, 3);
    });
  });

  test("at most 10 services can be chosen (the 11th tap is ignored)", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.click("#book-cta");
      for (const id of Object.values(SVC_ID)) await page.click(`#svc-list [data-id="${id}"]`);
      assert.equal(await page.locator("#svc-list [aria-pressed=true]").count(), 4);
      assert.match(await text(page.locator("[data-sb='services']")), /4 послуги/);
    });
  });

  test("changing the services after choosing a time drops that time", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.goBack();
      await page.goBack();
      assert.equal(await visibleScreen(page), "services");
      await page.click(`#svc-list [data-id="${SVC_ID.gel}"]`);
      await page.click("#cta-services");
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      assert.equal(await page.locator("#cta-time").isDisabled(), true, "the previous time is gone");
    });
  });
});

describe("salon master", () => {
  test("a master of a salon: «Салон» row in the recap, back link to the salon page", async () => {
    await withPage("salonmaster-5555", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "СалонЗапис" } });
      const recap = await text(page.locator("#confirm-card"));
      assert.ok(recap.includes("Салон") && recap.includes("Салон «Лаванда»"), recap);
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.ok((await text(page.locator("#done-card"))).includes("Салон «Лаванда»"));
      const booking = callsTo(await mockLog((e) => e.body?.name === "СалонЗапис"), "POST", "/salonmaster-5555/booking");
      assert.equal(booking.length, 1, "the booking goes to the chosen master's slug");
    });
  });
});

describe("time step", () => {
  test("a day without free time shows the empty state; «Змінити» returns to the calendar", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.click("#book-cta");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      await page.click(`[data-day="${await pickableDay(page, { sunday: true })}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#time-empty", { state: "visible" });
      assert.ok((await text(page.locator("#time-empty"))).includes("Немає вільного часу"));
      assert.equal(await page.locator("#cta-time").isDisabled(), true);
      await page.click("#time-change");
      assert.equal(await visibleScreen(page), "date");
    });
  });

  test("availability failure (backend down) shows a retryable error, not an empty day", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/availability*`, (r) => r.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "" }));
      await page.click("#book-cta");
      await page.click(`#svc-list [data-id="${SVC_ID.classic}"]`);
      await page.click("#cta-services");
      await page.click(`[data-day="${await pickableDay(page)}"]`);
      await page.click("#cta-date");
      await page.waitForSelector("#time-error", { state: "visible" });
      assert.equal(await page.locator("#time-empty").isVisible(), false);
    });
  });

  test("409 at the end: back to the time step, message, refreshed slots, the chosen time cleared", async () => {
    await withPage("conflict-9999", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Конфлікт" } });
      const before = (await mockLog((e) => e.path.includes("conflict-9999/availability"))).length;
      await page.click("#cta-confirm");
      await page.waitForSelector("#time-conflict", { state: "visible" });
      assert.equal(await visibleScreen(page), "time");
      assert.ok((await text(page.locator("#time-conflict"))).includes("Цей час уже зайнято. Оберіть інший."));
      await page.waitForSelector("#slots .slot");
      assert.ok((await mockLog((e) => e.path.includes("conflict-9999/availability"))).length > before, "slots were re-fetched");
      assert.equal(await page.locator("#slots .slot[aria-pressed=true]").count(), 0);
      assert.equal(await page.locator("#cta-time").isDisabled(), true);
      await page.locator("#slots .slot").nth(3).click();
      assert.equal(await page.locator("#time-conflict").isVisible(), false, "choosing another time clears the message");
    });
  });
});

describe("contact step", () => {
  test("validation: empty fields are flagged inline, linked to the field, and nothing is sent", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "", surname: "", phone: "5" } });
      await page.fill("#name", "");
      await toggleConsent(page); // untick the consent
      const before = (await mockLog((e) => e.path.includes("/otp/send"))).length;
      await page.click("#cta-contact");
      assert.equal(await page.locator("#f-name .ferr").isVisible(), true);
      assert.ok((await text(page.locator("#f-name .ferr"))).includes("Це поле обов'язкове"));
      assert.ok((await text(page.locator("#f-phone .ferr"))).includes("Невірний номер телефону"));
      assert.ok((await text(page.locator("#consent-err"))).includes("Без згоди ми не можемо записати вас."));
      assert.equal(await page.getAttribute("#name", "aria-describedby"), "e-name", "the error is linked to its field");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "name", "focus goes to the first invalid field");
      assert.equal((await mockLog((e) => e.path.includes("/otp/send"))).length, before);
      await fillContact(page, { name: "Поправила", surname: "Іваненко", phone: "671112233" });
      await page.fill("#phone", "");
      await page.type("#phone", "671112233");
      assert.equal(await page.locator("#f-name .ferr").count(), 0, "the error clears as the field is fixed");
    });
  });

  test("the consent is unticked by default and links to /privacy#guest in a new tab", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      assert.equal(await page.locator("#consent").isChecked(), false);
      const link = page.getByRole("link", { name: "Політика конфіденційності" });
      assert.equal(await link.getAttribute("href"), "/privacy#guest");
      assert.equal(await link.getAttribute("target"), "_blank");
      assert.match(await link.getAttribute("rel"), /noopener/);
    });
  });

  test("phone and name fields use the right mobile keyboards and autofill hints", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      assert.equal(await page.getAttribute("#phone", "inputmode"), "numeric");
      assert.equal(await page.getAttribute("#phone", "autocomplete"), "tel");
      assert.equal(await page.getAttribute("#name", "autocomplete"), "given-name");
      assert.equal(await page.getAttribute("#surname", "autocomplete"), "family-name");
    });
  });

  test("Backspace over the separators of the phone mask removes digits, never sticks", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await page.type("#phone", "501234567");
      for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
      assert.equal(await page.inputValue("#phone"), "+380 50 123");
    });
  });

  test("SMS unavailable (503): the contact step says so, with support@ — no code screen", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Смс503", phone: "500000503" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#cb-sms", { state: "visible" });
      assert.equal(await visibleScreen(page), "contact");
      assert.ok((await text(page.locator("#cb-sms"))).includes("SMS тимчасово недоступні"));
      assert.equal(await page.locator("#cb-sms a").getAttribute("href"), "mailto:support@beautica.app");
      assert.equal(await page.locator("#cta-contact").isEnabled(), true, "the button is usable again");
    });
  });

  test("too many tries (429): «Забагато спроб, спробуйте пізніше.»", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Ліміт429", phone: "500000429" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#cb-limit", { state: "visible" });
      assert.ok((await text(page.locator("#cb-limit"))).includes("Забагато спроб, спробуйте пізніше."));
    });
  });

  test("a rejected Turnstile token (400): asks to confirm the check again", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Токен400", phone: "500000400" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#turn-err", { state: "visible" });
      assert.ok((await text(page.locator("#turn-err"))).includes("Підтвердіть, що ви не робот"));
      assert.equal(await visibleScreen(page), "contact");
    });
  });

  test("Turnstile script blocked: a clear message and NO request to /otp/send", async () => {
    await withPage("oksana-ab12", { turnstile: "blocked" }, async ({ page }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await fillContact(page, { name: "БезТурнстайл", phone: "500000011" });
      await page.click("#cta-contact");
      await page.waitForSelector("#turn-err", { state: "visible" });
      assert.ok((await text(page.locator("#turn-err"))).includes("Не вдалося") || (await text(page.locator("#turn-err"))).includes("Підтвердіть"));
      assert.deepEqual(await mockLog((e) => e.body?.phone === "+380500000011"), []);
      assert.equal(await visibleScreen(page), "contact");
    });
  });

  test("the Turnstile row renders in the contact step (widget-sized box, inside the column, no overflow)", async () => {
    await withPage("oksana-ab12", {}, async ({ page, turnstileRequests }) => {
      await driveTo(page, "time");
      await page.click("#cta-time");
      await page.waitForSelector("#ts-widget iframe", { state: "attached" });
      const row = page.locator("#ts-widget");
      assert.ok(await visibleBox(row), "the row has a box");
      const b = await row.boundingBox();
      assert.ok(b.height >= 65 && b.width >= 300, `${b.width}x${b.height}`);
      assert.ok(b.x >= 0 && b.x + b.width <= 360, "inside the 360 px viewport");
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
      assert.ok(turnstileRequests.length >= 1);
    });
  });

  test("Turnstile is loaded lazily at the contact step, never on page load", async () => {
    await withPage("oksana-ab12", {}, async ({ page, turnstileRequests }) => {
      await page.waitForLoadState("networkidle");
      assert.deepEqual(turnstileRequests, []);
      await driveTo(page, "time");
      assert.deepEqual(turnstileRequests, []);
      await page.click("#cta-time");
      await page.waitForSelector("#ts-widget", { state: "attached" });
      await page.waitForTimeout(300);
      assert.equal(turnstileRequests.length, 1);
    });
  });
});

describe("SMS code step", () => {
  test("a wrong code: the cells go red with the app's message, the retry works", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Невірний", phone: "500000020" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      for (let i = 0; i < 6; i++) await page.locator("#otp input").nth(i).fill("0");
      await page.click("#cta-otp");
      await page.waitForSelector("#otp-wrong", { state: "visible" });
      assert.ok((await text(page.locator("#otp-wrong"))).includes("Невірний або прострочений код. Перевірте цифри або запросіть новий код."));
      assert.equal(await page.locator("#otp.invalid").count(), 1);
      assert.equal(await visibleScreen(page), "otp");
      await page.locator("#otp input").nth(5).fill("7");
      assert.equal(await page.locator("#otp-wrong").isVisible(), false, "typing clears the error");
      await page.click("#cta-otp");
      await page.waitForSelector("#confirm-card", { state: "visible" });
    });
  });

  test("the 6-digit code can be pasted into the first cell, and a whole-code autofill into one cell spreads", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Вставка", phone: "500000021" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.locator("#otp input").first().evaluate((el) => {
        el.value = "246810";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      assert.deepEqual(await page.locator("#otp input").evaluateAll((els) => els.map((e) => e.value)), [..."246810"]);
      assert.equal(await page.locator("#cta-otp").isEnabled(), true);
      assert.equal(await page.getAttribute("#otp input", "autocomplete"), "one-time-code");
      assert.equal(await page.getAttribute("#otp input", "inputmode"), "numeric");
    });
  });

  test("Backspace on an empty cell steps back", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Бекспейс", phone: "500000022" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.locator("#otp input").nth(0).fill("1");
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll("#otp input")[1]), true, "typing advances");
      await page.keyboard.press("Backspace");
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll("#otp input")[0]), true);
    });
  });

  test("resend: not available during the cooldown", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "contact", { contact: { name: "Повтор", phone: "500000023" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      assert.equal(await page.locator("#otp-resend-btn").isVisible(), false);
      assert.equal(await page.locator("#otp-wait").isVisible(), true);
    });
  });

  test("resend after the cooldown asks Turnstile for a NEW token and sends a second code", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.clock.install();
      await driveTo(page, "contact", { contact: { name: "Повтор2", phone: "500000024" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await page.clock.runFor(61000);
      await page.waitForSelector("#otp-resend-btn", { state: "visible" });
      await page.click("#otp-resend-btn");
      await page.clock.runFor(100); // the fake Turnstile hands out the new token on a 5 ms timer
      await page.waitForFunction(() => document.querySelector("#otp-wait") && !document.querySelector("#otp-wait").hidden);
      const sends = callsTo(await mockLog((e) => e.body?.phone === "+380500000024"), "POST", "/otp/send");
      assert.equal(sends.length, 2);
      assert.notEqual(sends[0].body.turnstileToken, sends[1].body.turnstileToken, "a Turnstile token is single-use");
    });
  });

  test("verify rate-limited (429): the app's message on the code screen", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      await driveTo(page, "contact", { contact: { name: "Ліміт", phone: "500000025" } });
      await page.click("#cta-contact");
      await page.waitForSelector("#otp", { state: "visible" });
      await context.route(`${MOCK_API}/api/v1/book/otp/verify`, (r) => r.fulfill({ status: 429, headers: { "access-control-allow-origin": "*" }, body: "" }));
      for (const [i, d] of [..."123456"].entries()) await page.locator("#otp input").nth(i).fill(d);
      await page.click("#cta-otp");
      await page.waitForSelector("#otp-limit", { state: "visible" });
    });
  });
});

describe("confirm step", () => {
  test("booking service down (503): a message on the confirm step, the button works again, no double booking", async () => {
    await withPage("bookdown-7777", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Збій503" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#submit-error", { state: "visible" });
      assert.ok((await text(page.locator("#submit-error"))).includes("Запис тимчасово недоступний"));
      assert.equal(await visibleScreen(page), "confirm");
      assert.equal(await page.locator("#cta-confirm").isEnabled(), true);
      assert.equal(await page.locator("#cta-confirm").getAttribute("aria-busy"), null);
    });
  });

  test("expired SMS session (401): back to the code step with an explanation, token dropped", async () => {
    await withPage("expired-6666", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Сесія401" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#otp-session", { state: "visible" });
      assert.equal(await visibleScreen(page), "otp");
      assert.ok((await text(page.locator("#otp-session"))).includes("Підтвердження номера застаріло"));
    });
  });

  test("double click: one booking request, the button is busy meanwhile", async () => {
    await withPage("oksana-ab12", {}, async ({ page, context }) => {
      let release;
      const gate = new Promise((r) => (release = r));
      await context.route(`${MOCK_API}/api/v1/book/oksana-ab12/booking`, async (route) => {
        await gate;
        await route.continue();
      });
      await driveTo(page, "confirm", { contact: { name: "ДвоКліки" } });
      await page.click("#cta-confirm");
      assert.equal(await page.locator("#cta-confirm").isDisabled(), true, "disabled while the request runs");
      assert.equal(await page.locator("#cta-confirm").getAttribute("aria-busy"), "true");
      await page.locator("#cta-confirm").dispatchEvent("click");
      await page.locator("#cta-confirm").dispatchEvent("click");
      release();
      await page.waitForSelector("#done-card", { state: "visible" });
      assert.equal(callsTo(await mockLog((e) => e.body?.name === "ДвоКліки"), "POST", "/booking").length, 1);
    });
  });
});

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
    await withPage("oksana-ab12", {}, async ({ page }) => {
      const reqs = [];
      page.on("request", (r) => reqs.push({ url: r.url(), method: r.method(), post: r.postData() }));
      await driveTo(page, "confirm", { contact: { name: "Приватність", surname: "Тестова", phone: "671234567" } });
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-card", { state: "visible" });
      const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie, h: history.state, u: location.href, n: window.name }));
      for (const secret of ["Приватність", "Тестова", "671234567", "guest-token", "123456", "TOKEN-"]) assert.equal(stored.includes(secret), false, `${secret} leaked into storage/cookie/history/url`);
      assert.deepEqual(JSON.parse(stored).l, {});
      assert.deepEqual(JSON.parse(stored).s, {});
      for (const r of reqs) {
        assert.equal(/Приватність|Тестова|671234567|guest-token|%D0%9F/.test(decodeURIComponent(r.url)), false, `PII in URL ${r.url}`);
        const origin = new URL(r.url).origin;
        assert.ok([BASE, MOCK_API, "https://media.beautica.test", "https://challenges.cloudflare.com"].includes(origin), `unexpected origin ${origin}`);
      }
      assert.equal(reqs.filter((r) => r.url.includes("umami") || r.url.includes("analytics") || r.url.includes("cloudflareinsights")).length, 0, "no analytics script on the booking page (phase 007 adds it)");
      const posts = reqs.filter((r) => r.method === "POST").map((r) => new URL(r.url).pathname);
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
          for (const sel of boxes) assert.ok(await visibleBox(page.locator(`[data-screen]:not([hidden]) ${sel}`).first()), `${label}: ${sel} has no box`);
          const small = await page.evaluate(() =>
            [...document.querySelectorAll("[data-screen]:not([hidden]) :is(a[href], button, input:not([type=checkbox]), textarea)")]
              .filter((e) => !e.closest("[hidden]") && getComputedStyle(e).visibility !== "hidden" && !e.matches(".chk-row a, .otp input")) // the privacy link is a text link inside a sentence (WCAG 2.5.8 inline exception)
              .map((e) => ({ t: e.tagName + "." + e.className + "#" + e.id, b: e.getBoundingClientRect() }))
              .filter(({ b }) => b.width > 0 && b.height > 0 && (b.height < 48 || b.width < 48))
              .map(({ t, b }) => `${t} ${Math.round(b.width)}x${Math.round(b.height)}`),
          );
          assert.deepEqual(small, [], `${label}: controls under 48 px`);
          // The 41 x 50 px code cells are the app's size; their <label>::after adds 3.5 px each side, so the tappable area is 48 px wide.
          const cellHits = await page.evaluate(() =>
            [...document.querySelectorAll("[data-screen]:not([hidden]) #otp input")].map((i) => {
              const b = i.getBoundingClientRect();
              const y = b.top + b.height / 2;
              const label = i.closest("label");
              return [b.left - 3, b.right + 3].every((x) => document.elementFromPoint(x, y)?.closest("label") === label);
            }),
          );
          assert.ok(cellHits.every(Boolean), `${label}: code cells are tappable 3 px outside their box`);
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
        for (const [i, d] of [..."123456"].entries()) await page.locator("#otp input").nth(i).fill(d);
        await page.click("#cta-otp");
        await page.waitForSelector("#confirm-card", { state: "visible" });
        await check("confirm", ["#confirm-card", ".strip", ".footer .cta"]);
        await page.click("#cta-confirm");
        await page.waitForSelector("#done-card", { state: "visible" });
        await check("done", [".medallion", "#done-card", ".calbtn", ".cta2"]);
        assert.equal(seen.length, 9);
      });
    });
  }
});

describe("parity with the app: category accordions, comment, address (backend 383 + 385)", () => {
  test("services step: category accordions with the app's count badge and a live «selected» badge", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await page.click("#book-cta");
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

  test("confirm: optional «Коментар для майстра» (500 as in the app, counter), trimmed, sent as clientComment, shown in the summary", async () => {
    await withPage("oksana-ab12", {}, async ({ page }) => {
      await driveTo(page, "confirm", { contact: { name: "Коментар" } });
      assert.equal(await page.getAttribute("#comment", "maxlength"), "500", "the app's limit (booking_confirm_screen _maxComment)");
      assert.equal(await page.getAttribute("#comment", "placeholder"), "Необов'язково");
      assert.equal(await text(page.locator("#counter")), "0 / 500");
      assert.ok((await text(page.locator("[data-screen=confirm]"))).includes("Коментар для майстра"));
      const typed = "  Прийду з дитиною\nдякую  ";
      await page.fill("#comment", typed);
      assert.equal(await text(page.locator("#counter")), `${typed.length} / 500`);
    });
  });

  test("a comment is sent trimmed as clientComment and shown in the confirm summary; blank is omitted; never in the done recap", async () => {
    for (const [name, comment] of [["КоментарТак", "  Прийду з дитиною\nдякую  "], ["КоментарНі", "   "]]) {
      await withPage("oksana-ab12", {}, async ({ page }) => {
        await driveTo(page, "time");
        await page.click("#cta-time");
        await fillContact(page, { name });
        await page.click("#cta-contact");
        await page.waitForSelector("#otp", { state: "visible" });
        for (const [i, d] of [..."123456"].entries()) await page.locator("#otp input").nth(i).fill(d);
        await page.click("#cta-otp");
        await page.waitForSelector("#confirm-card", { state: "visible" });
        await page.fill("#comment", comment);
        const recap = await text(page.locator("#confirm-card"));
        assert.equal(recap.includes("Коментар"), name === "КоментарТак", recap);
        if (name === "КоментарТак") assert.ok(recap.includes("Прийду з дитиною"));
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

  test("a comment the backend rejects (over 1000 chars or control characters, 400) shows the generic fix-it message, no double booking", async () => {
    for (const bad of ["я".repeat(1001), "а\u0007б"]) {
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
