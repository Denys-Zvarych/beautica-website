// Phases 016 + 017: the salon booking wizard on /book/s/{slug} (the app's client salon flow) and the services-tab filter.
// Mock fixture: slugs "wiz-*" (tests/helpers/mock-api.mjs): masters M1/M2 without a personal link, M3 with one;
// S1 classic (M1, M2)  S2 gel (M1)  S3 brows (M2, M3)  S4 pedicure (nobody). M2 is off on Mondays, everybody on Sundays.
// Every test owns its slug and phone (the mock log is shared).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { BASE, MOCK_API, rawRequest, requireBase, uk } from "./helpers/env.mjs";
import { callsTo, mockLog, shot } from "./helpers/book.mjs";
import { wizAssign, wizMasterId, GUEST_TOKEN } from "./helpers/mock-api.mjs";
import { M1, M2, M3, S1, S2, S3, S4, salonPage, pickServices, openAll, toggleMaster, chip, clickAndLoadDays, nextMaster, days, pickDay, pickSlot, scheduleMaster, verifyOtp, toConfirm } from "./helpers/salon.mjs";
import { parseIcs } from "./helpers/ics-parse.mjs";
import { gzipSync } from "node:zlib";

requireBase();
const get = (path) => rawRequest(path);
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const text = (loc) => loc.innerText().then((s) => s.replace(/\s+/g, " ").trim());
const noProblems = (env) => assert.deepEqual(env.problems.filter((p) => !/status of (409|401|429|503|400|504)|net::ERR_FAILED/.test(p)), [], "no console / page errors");

describe("salon page: the team and the entry point", () => {
  test("a master without a personal link is a plain card (no link, no href); one with a link opens it; the CTA opens the wizard", async () => {
    const env = await salonPage(browser, "wiz-team-0001");
    try {
      const { page } = env;
      await page.click('[data-tab="1"]');
      const cards = page.locator("[data-mgrid] .mcard");
      assert.equal(await cards.count(), 3);
      const info = await cards.evaluateAll((els) => els.map((e) => ({ tag: e.tagName, href: e.getAttribute("href") })));
      assert.deepEqual(info, [{ tag: "DIV", href: null }, { tag: "DIV", href: null }, { tag: "A", href: "/book/master-3abc" }]);
      assert.equal(await page.locator("a[href*='null'], a[href='/book/null']").count(), 0, "no /book/null link");
      assert.equal(await page.locator("#book-cta").isVisible(), true);
      assert.equal(await page.locator("[data-nojs]").isHidden(), true);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("without script the CTA still scrolls to the masters tab and the plain cards stay in the HTML", async () => {
    const res = await get("/book/s/wiz-team-0002");
    assert.equal(res.status, 200);
    assert.match(res.body, /data-nojs/);
    assert.match(res.body, /href="#panel-1"/);
    assert.equal((res.body.match(/data-master-id=/g) ?? []).length, 3);
    assert.equal(/href="\/book\/null"|href="\/book\/undefined"/.test(res.body), false);
    // Phase 016 audit: the wizard is not in the page (steps, strips, coverage and the catalogue are fetched on intent).
    for (const gone of ['id="book-steps"', 'id="salon-data"', 'data-screen="date"', 'id="tpl-appt"', 'id="svc-list"', "data-covers"]) assert.equal(res.body.includes(gone), false, gone);
    assert.ok(gzipSync(res.body).length < 19000, `the page is ${gzipSync(res.body).length} B gzipped`);
  });
});

describe("016: services step", () => {
  test("the whole catalogue by category (first one open), salon-wide price labels, multi-select across categories", async () => {
    const env = await salonPage(browser, "wiz-svc-0001");
    try {
      const { page } = env;
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      assert.match(await text(page.locator("[data-screen=services]")), /Крок 1 з 4/);
      const open = await page.locator("#svc-list details").evaluateAll((d) => d.map((x) => x.open));
      assert.deepEqual(open, [true, false, false], "only the first category is open");
      assert.equal(await page.locator("#svc-list [data-id]").count(), 4, "the whole catalogue, not one master's");
      await page.locator("#svc-list details").nth(1).locator("summary").click();
      assert.match(await text(page.locator(`#svc-list [data-id="${S3.id}"]`)), /600 - 900 ₴/, "the salon-wide price label, never a per-master price");
      await page.click(`#svc-list [data-id="${S1.id}"]`);
      await page.click(`#svc-list [data-id="${S3.id}"]`);
      assert.equal(await page.locator("#svc-list [aria-pressed=true]").count(), 2);
      await page.click("#cta-services");
      await page.waitForSelector("[data-screen=masters]:not([hidden])");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a visit holds at most 10 services: the 11th shows the app's message and is not added", async () => {
    const env = await salonPage(browser, "wiz-many-0001");
    try {
      const { page } = env;
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      await openAll(page, "#svc-list");
      const tiles = page.locator("#svc-list [data-id]");
      assert.ok((await tiles.count()) >= 11);
      for (let i = 0; i < 10; i++) await tiles.nth(i).click();
      assert.equal(await page.locator("#cap-note").isHidden(), true);
      await tiles.nth(10).click();
      assert.equal(await text(page.locator("#cap-note")), "Можна обрати щонайбільше 10 послуг за один візит.");
      assert.equal(await page.locator("#svc-list [aria-pressed=true]").count(), 10);
      await tiles.nth(0).click(); // deselecting clears the note
      assert.equal(await page.locator("#cap-note").isHidden(), true);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("016: masters step (coverage assignment, no «any master»)", () => {
  test("lists a master who performs AT LEAST ONE selected service; «Далі» stays disabled until every service has one master", async () => {
    const env = await salonPage(browser, "wiz-mst-0001");
    try {
      const { page } = env;
      await pickServices(page, S1, S3);
      await page.click("#cta-services");
      const rows = await page.locator("#master-list input").evaluateAll((e) => e.map((x) => x.dataset.master));
      assert.deepEqual(rows, [M1.id, M2.id, M3.id], "M1 (S1), M2 (S1+S3), M3 (S3), in roster order");
      assert.equal(await page.locator("#cta-masters").isDisabled(), true, "nothing picked yet");
      assert.match(await text(page.locator("#plan")), /Оберіть майстрів — послуги згрупуються тут за майстром/);
      assert.equal(await page.getByText(/будь-який|Будь-який/).count(), 0, "no «any master»");
      await toggleMaster(page, M2); // performs both: all assigned
      assert.equal(await page.locator("#cta-masters").isDisabled(), false);
      assert.match(await text(page.locator("#masters-progress")), /2 з 2 призначено/);
      assert.match(await text(page.locator("#plan")), /Ірина Мельник.*Манікюр класичний, Корекція брів/);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a service two picked masters can do needs a chip; «Оберіть майстра…» for one nobody does", async () => {
    const env = await salonPage(browser, "wiz-mst-0002");
    try {
      const { page } = env;
      await pickServices(page, S1, S3, S4);
      await page.click("#cta-services");
      await toggleMaster(page, M1);
      await toggleMaster(page, M2);
      // S1 is performed by both picked masters -> unresolved; S3 only by M2 -> auto; S4 by nobody -> the «Оберіть майстра, який виконує …» row.
      assert.match(await text(page.locator("#plan")), /Манікюр класичний\s*оберіть майстра/);
      assert.match(await text(page.locator("#plan")), /Оберіть майстра, який виконує Педикюр апаратний/);
      assert.equal(await page.locator("#cta-masters").isDisabled(), true);
      await chip(page, S1, M1).click();
      assert.equal(await chip(page, S1, M1).getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#cta-masters").isDisabled(), true, "S4 still has no master");
      assert.match(await text(page.locator("#masters-progress")), /2 з 3 призначено/);
      assert.match(await text(page.locator("#plan-count")), /2 записи/);
      // Back to services, drop S4: everything is assigned, two appointments (M1: S1, M2: S3).
      await page.click("[data-screen=masters] [data-back]");
      await page.click(`#svc-list [data-id="${S4.id}"]`);
      await page.click("#cta-services");
      assert.equal(await page.locator("#cta-masters").isDisabled(), false);
      assert.match(await text(page.locator("#plan")), /Олена Бондар.*Манікюр класичний/);
      assert.match(await text(page.locator("#plan")), /Ірина Мельник.*Корекція брів/);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("016: the whole story, one booking per master", () => {
  test("per-master bookable days and slots, contact + OTP once, a card per master, two POSTs with ONE token, a calendar link each, no cancel link", async () => {
    const slug = "wiz-story-0001";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      await pickServices(page, S2, S3);
      await page.click("#cta-services");
      await toggleMaster(page, M1);
      await toggleMaster(page, M2);
      await clickAndLoadDays(page, "#cta-masters");
      // --- master 1 (gel only): works on Mondays, never on Sundays
      assert.match(await text(page.locator("[data-screen=date]")), /Майстер 1 з 2/);
      assert.match(await text(page.locator("[data-screen=date] .strip")), /Олена Бондар/);
      assert.ok((await days(page, [1])).some((d) => d.ok), "master 1 works on a Monday");
      assert.ok((await days(page, [0])).every((d) => d.disabled), "nobody works on Sundays");
      const d1 = await pickDay(page);
      await page.click("#cta-date");
      await pickSlot(page, 1);
      assert.equal(await text(page.locator("#cta-time")), "Далі", "not the last master yet");
      // --- master 2 (brows): Mondays are off for her only
      await nextMaster(page);
      assert.match(await text(page.locator("[data-screen=date]")), /Майстер 2 з 2/);
      assert.match(await text(page.locator("[data-screen=date] .strip")), /Ірина Мельник/);
      const mondays = await days(page, [1]);
      assert.ok(mondays.length > 0 && mondays.every((d) => d.disabled), "master 2 is off on Mondays");
      const d2 = await pickDay(page);
      await page.click("#cta-date");
      await pickSlot(page, 2);
      assert.equal(await text(page.locator("#cta-time")), "Підтвердити", "the last master confirms");
      // the pager goes back to master 1 and keeps his choice
      await page.locator("[data-screen=time] [data-mprev]").click();
      await page.waitForSelector("[data-screen=time]:not([hidden])");
      assert.match(await text(page.locator("[data-screen=time] .strip")), /Олена Бондар/);
      assert.equal(await page.locator("#slots .slot[aria-pressed=true]").count(), 1, "his time is kept");
      await page.locator("[data-screen=time] [data-mnext]").click();
      await page.waitForSelector("#slots .slot[aria-pressed=true]");
      await page.click("#cta-time");
      await verifyOtp(page, "501110001");
      // --- confirm: one card per master, each with its own comment, no grand total
      const cards = page.locator("#salon-cards [data-appt]");
      assert.equal(await cards.count(), 2);
      assert.equal(await page.locator("#salon-cards .total-row").count(), 2, "a subtotal per card, no visit-wide total");
      assert.match(await text(page.locator("#salon-addr")), /Салон.*Мозаїка.*Адреса.*Львів, вул\. Городоцька, 7/);
      assert.match(await text(cards.nth(0)), /Олена Бондар.*Манікюр\+гель лак.*Разом.*від 650 ₴/);
      assert.match(await text(cards.nth(1)), /Ірина Мельник.*Корекція брів.*Разом.*від 600 ₴/);
      await cards.nth(0).locator("textarea").fill("Для першої");
      await cards.nth(1).locator("textarea").fill("Для другої");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-list [data-done]", { state: "visible" });
      // --- the two POSTs: sequential, same token, own services / comment, salon routes
      const posts = callsTo(await mockLog(), "POST", `/book/s/${slug}/masters/`);
      assert.equal(posts.length, 2);
      assert.ok(posts[0].path.endsWith(`/masters/${M1.id}/booking`) && posts[1].path.endsWith(`/masters/${M2.id}/booking`), "master 1 first, then master 2");
      for (const p of posts) assert.equal(p.headers.authorization, `Bearer ${GUEST_TOKEN}`);
      assert.deepEqual(posts[0].body.masterServiceIds, [wizAssign(1, 2)]);
      assert.deepEqual(posts[1].body.masterServiceIds, [wizAssign(2, 3)]);
      assert.equal(posts[0].body.clientComment, "Для першої");
      assert.equal(posts[1].body.clientComment, "Для другої");
      assert.equal(posts[0].body.serviceId, undefined);
      assert.ok(posts[0].body.startsAt.startsWith(d1) && posts[1].body.startsAt.startsWith(d2));
      assert.equal(posts[0].body.privacyAccepted, true);
      assert.equal((await mockLog((e) => e.path.includes("/otp/send"))).filter((e) => e.body.phone === "+380501110001").length, 1, "one code for the whole visit");
      // --- done (phase 025): each booking has its own calendar link to /api/ics; no cancel link, text or button (the cancel link arrives by SMS)
      assert.equal(await page.locator("[data-screen=done]").getByText("На головну").count(), 0, "no «На головну» on the success screen");
      assert.equal(await page.locator("[data-screen=done] a[href='/']:not([hidden])").count(), 0, "no link to the home page");
      const done = page.locator("#done-list [data-done]");
      assert.equal(await done.count(), 3, "the salon address card + one per master");
      assert.equal(await page.locator("#done-list a[data-done-cancel], #done-list a[href*='/book/cancel']").count(), 0, "no cancel link");
      assert.equal(/Скасувати|не пізніше ніж за 2 години/.test(await text(page.locator("[data-screen=done]"))), false, "no cancel text / button");
      const cals = page.getByRole("link", { name: uk.book.done.calendarApple });
      assert.equal(await cals.count(), 2, "one calendar link per master");
      assert.equal(await page.getByRole("button", { name: uk.book.done.calendarApple }).count(), 0);
      const hrefs = await cals.evaluateAll((a) => a.map((x) => x.getAttribute("href")));
      for (const h of hrefs) assert.equal(new URL(h, "https://x.example").pathname, "/api/ics");
      assert.equal(hrefs.some((h) => /cancel|123e4567/.test(decodeURIComponent(h))), false, "no cancel token in a calendar URL");
      const res = await page.request.get(new URL(hrefs[1], page.url()).href);
      assert.equal(res.status(), 200);
      const ics = parseIcs(await res.text());
      assert.equal("URL" in ics.VEVENT, false, "no cancel link in master 2's file");
      assert.equal(ics.text.SUMMARY, "Запис до Ірина Мельник");
      assert.equal(await page.locator("#done-list").evaluate((e) => e.scrollWidth <= e.clientWidth), true);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });

  test("master 2 answers 409: master 1 stays booked, the failed card says which, «Змінити час» -> a new time -> only master 2 is retried", async () => {
    const env = await salonPage(browser, "wiz-c409-0001");
    try {
      const { page } = env;
      await pickServices(page, S2, S3);
      await page.click("#cta-services");
      await toggleMaster(page, M1);
      await toggleMaster(page, M2);
      await clickAndLoadDays(page, "#cta-masters");
      await scheduleMaster(page, 1);
      await nextMaster(page);
      await scheduleMaster(page, 0); // 09:00: refused for master 2
      await page.click("#cta-time");
      await verifyOtp(page, "501110003");
      await page.click("#cta-confirm");
      const second = page.locator('#salon-cards [data-appt]').nth(1);
      await second.locator("[data-appt-error]:not([hidden])").waitFor();
      const first = page.locator("#salon-cards [data-appt]").nth(0);
      assert.equal(await first.locator("[data-appt-ok]").isVisible(), true, "master 1 is booked");
      assert.equal(await first.locator("textarea").evaluate((t) => t.readOnly), true);
      assert.match(await text(second.locator("[data-appt-error]")), /Запис до Ірина Мельник не створено\. Цей час уже зайнято\. Оберіть інший\./);
      assert.equal(await page.locator("#cta-confirm").innerText(), "Спробувати знову");
      assert.equal(await page.locator("[data-screen=done]").isHidden(), true);
      // change the time of the failed one only
      await second.locator("[data-appt-change]").click();
      await page.waitForSelector("[data-screen=time]:not([hidden])");
      assert.match(await text(page.locator("[data-screen=time] .strip")), /Ірина Мельник/);
      assert.equal(await page.locator("[data-screen=time] [data-mpager]").isHidden(), true, "no pager once somebody is booked");
      await pickSlot(page, 3);
      await page.click("#cta-time");
      await page.waitForSelector("#salon-cards", { state: "visible" });
      assert.equal(await page.locator("#salon-cards [data-appt]").count(), 2);
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-list [data-done]", { state: "visible" });
      const posts = callsTo(await mockLog(), "POST", "/book/s/wiz-c409-0001/masters/");
      assert.deepEqual(posts.map((p) => p.path.split("/masters/")[1].split("/")[0]), [M1.id, M2.id, M2.id], "master 1 is posted ONCE; master 2 twice");
      assert.equal(await page.locator("#done-list .calbtn[data-cal=apple]").count(), 2, "both bookings done, one calendar link each");
      assert.equal(await page.locator("#done-list .calbtn[data-cal=google]").count(), 2, "both bookings done, one Google link each too");
      const withCal = page.locator("#done-list [data-done]").filter({ has: page.locator(".calbtn") });
      assert.equal(await withCal.count(), 2, "two booking cards carry calendar buttons (the salon recap card has none)");
      for (const item of await withCal.all()) {
        const [a, b] = await item.locator(".calbtn").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
        assert.ok(Math.abs(a.y - b.y) < 1 && a.width > 0 && b.width > 0, "the two calendar buttons share one row");
      }
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("016: every step renders at 360 / 768 / 1280 (non-zero boxes, no sideways scroll)", () => {
  for (const width of [360, 768, 1280]) {
    test(`${width}px: services, masters (chips + plan), date + pager, time, confirm cards, done`, async () => {
      const env = await salonPage(browser, `wiz-vis-${width}`, { width, height: 900 });
      try {
        const { page } = env;
        const visible = async (sel) => {
          const b = await page.locator(sel).first().boundingBox();
          assert.ok(b && b.width > 0 && b.height > 0, `${sel} has a box at ${width}px`);
          return b;
        };
        const noScroll = async (where) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${where}: no horizontal scroll at ${width}px`);
        await pickServices(page, S1, S2, S3);
        await visible("#cta-services");
        await shot(page, `salon-${width}-1-services`);
        await noScroll("services");
        await page.click("#cta-services");
        await toggleMaster(page, M1);
        await toggleMaster(page, M2);
        for (const sel of ["#master-list .mrow .strip", "#master-list .mrow .chk", "#master-list .mrow .cov", "[data-chip]", "#plan .pgroup .ravatar", "#plan .pwell", "#cta-masters"]) await visible(sel);
        await shot(page, `salon-${width}-2-masters-unresolved`);
        await chip(page, S1, M1).click();
        await noScroll("masters");
        await shot(page, `salon-${width}-2-masters`);
        await clickAndLoadDays(page, "#cta-masters");
        for (const sel of ["[data-screen=date] [data-mpager] [data-mprev]", "[data-screen=date] [data-mcount]", "[data-screen=date] .strip", ".dbtn.ok"]) await visible(sel);
        const targets = await page.locator("[data-screen=date] [data-mpager] .chevbtn").evaluateAll((b) => b.map((x) => [x.getBoundingClientRect().width, x.getBoundingClientRect().height]));
        for (const [w, h] of targets) assert.ok(w >= 47.99 && h >= 47.99, "pager arrows are >= 48 px");
        await shot(page, `salon-${width}-3-date`);
        await scheduleMaster(page, 1);
        await visible("#slots .slot");
        await shot(page, `salon-${width}-3-time`);
        await noScroll("time");
        await nextMaster(page);
        await scheduleMaster(page, 1);
        await page.click("#cta-time");
        await verifyOtp(page, `5012000${width % 100}`.slice(0, 9));
        for (const sel of ["#salon-cards [data-appt] .strip", "#salon-cards [data-appt] textarea", "#salon-cards .total-row", "#salon-addr"]) await visible(sel);
        await shot(page, `salon-${width}-4-confirm`);
        await noScroll("confirm");
        await page.click("#cta-confirm");
        await page.waitForSelector("#done-list [data-done]", { state: "visible" });
        for (const sel of ["#done-list .calbtn[data-cal=apple]", "#done-list .sumcard"]) await visible(sel);
        await shot(page, `salon-${width}-5-done`);
        await noScroll("done");
        noProblems(env);
      } finally {
        await env.context.close();
      }
    });
  }
});

describe("016: salon routes only, never the personal-link routes", () => {
  test("the wizard never calls /book/{slug}/... for a salon master; every call is under /book/s/{slug}/masters/{id}", async () => {
    const slug = "wiz-route-0001";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      await pickServices(page, S3);
      await page.click("#cta-services");
      await toggleMaster(page, M3); // M3 has a personal link too, but the wizard still books through the salon
      await clickAndLoadDays(page, "#cta-masters");
      await scheduleMaster(page, 1);
      await page.click("#cta-time");
      await verifyOtp(page, "501110004");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-list [data-done]", { state: "visible" });
      const log = await mockLog((e) => !e.path.startsWith("/api/v1/book/otp") && !e.path.includes("/info") && !e.path.includes("/reviews") && e.path.includes(slug));
      assert.ok(log.length >= 3);
      for (const e of log) assert.match(e.path, new RegExp(`^/api/v1/book/s/${slug}/masters/${M3.id}/(bookable-days|availability|booking)`));
      assert.equal((await mockLog((e) => /\/api\/v1\/book\/master-3abc\//.test(e.path))).length, 0);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("017: the services tab filters the masters tab", () => {
  test("tap a service: the masters tab opens with only the masters who do it and a chip; the chip clears; a second tap clears too", async () => {
    const env = await salonPage(browser, "wiz-flt-0001");
    try {
      const { page } = env;
      await page.click('[data-tab="2"]');
      await openAll(page, "#panel-2");
      const tile = page.locator(`[data-filter-id="${S3.id}"]`);
      assert.equal(await tile.getAttribute("role"), "button");
      await tile.click();
      await page.waitForSelector("[data-filter-chip]:not([hidden])"); // the coverage is fetched on the first tap
      assert.equal(await page.locator('[data-tab="1"]').getAttribute("aria-selected"), "true", "jumped to «Майстри»");
      const shown = await page.locator("[data-mgrid] .mcard:not([hidden])").evaluateAll((e) => e.map((x) => x.dataset.masterId));
      assert.deepEqual(shown, [M2.id, M3.id]);
      assert.equal(await text(page.locator("[data-filter-chip]")), "Послуга: Корекція брів");
      assert.equal(await page.locator("[data-filter-chip]").isVisible(), true);
      const box = await page.locator("[data-filter-clear]").boundingBox();
      assert.ok(box.width >= 24 && box.height >= 24, "the × has a box");
      await page.locator("[data-filter-clear]").click();
      assert.equal(await page.locator("[data-mgrid] .mcard:not([hidden])").count(), 3);
      assert.equal(await page.locator("[data-filter-chip]").isHidden(), true);
      // select again, then clear from the services tab by tapping the same service
      await page.click('[data-tab="2"]');
      await tile.click();
      await page.waitForSelector("[data-filter-chip]:not([hidden])");
      assert.equal(await tile.getAttribute("aria-pressed"), "true");
      await page.click('[data-tab="2"]');
      await tile.click();
      assert.equal(await tile.getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator("[data-mgrid] .mcard:not([hidden])").count(), 3);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a service nobody performs shows «Немає майстрів для цієї послуги»", async () => {
    const env = await salonPage(browser, "wiz-flt-0002");
    try {
      const { page } = env;
      await page.click('[data-tab="2"]');
      await openAll(page, "#panel-2");
      await page.locator(`[data-filter-id="${S4.id}"]`).click();
      await page.waitForSelector("[data-filter-empty]:not([hidden])");
      assert.equal(await page.locator("[data-mgrid] .mcard:not([hidden])").count(), 0);
      assert.equal(await text(page.locator("[data-filter-empty]")), "Немає майстрів для цієї послуги");
      await page.locator("[data-filter-clear]").click();
      assert.equal(await page.locator("[data-filter-empty]").isHidden(), true);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("QA 016/017: gaps closed", () => {
  test("017: a filtered set is shown whole (even past the cap of 6); clearing re-arms the «Показати всіх» collapse", async () => {
    const env = await salonPage(browser, "wiz-crowd-0001");
    try {
      const { page } = env;
      await page.click('[data-tab="1"]');
      assert.equal(await page.locator("#showall").isVisible(), true, "8 masters: the cap starts armed");
      assert.equal(await page.locator("#mrest").isHidden(), true);
      await page.click('[data-tab="2"]');
      await openAll(page, "#panel-2");
      await page.locator(`[data-filter-id="${S4.id}"]`).click();
      await page.waitForSelector("[data-filter-chip]:not([hidden])");
      const shown = await page.locator("[data-mgrid] .mcard:not([hidden])").evaluateAll((e) => e.map((x) => x.dataset.masterId));
      assert.deepEqual(shown, [wizMasterId(8)], "only the 8th master, who sits behind the cap");
      assert.equal(await page.locator("#mrest").isVisible(), true, "the collapsed part is opened for a filtered set");
      assert.equal(await page.locator("#showall").isHidden(), true);
      await page.locator("[data-filter-clear]").click();
      assert.equal(await page.locator("#mrest").isHidden(), true, "cleared: the cap is armed again");
      assert.equal(await page.locator("#showall").isVisible(), true);
      assert.equal(await page.locator("[data-mgrid] .mcard:not([hidden]):visible").count(), 6, "only the first six cards are visible again");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("017: the tiles work by keyboard (Enter and Space) and the × has a 48 px hit area", async () => {
    const env = await salonPage(browser, "wiz-key-0001");
    try {
      const { page } = env;
      await page.click('[data-tab="2"]');
      await openAll(page, "#panel-2");
      const tile = page.locator(`[data-filter-id="${S1.id}"]`);
      assert.equal(await tile.getAttribute("tabindex"), "0");
      await tile.focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-filter-chip]:not([hidden])");
      assert.deepEqual(await page.locator("[data-mgrid] .mcard:not([hidden])").evaluateAll((e) => e.map((x) => x.dataset.masterId)), [M1.id, M2.id]);
      // the 24 px disc has a 48 px hit area (a ::after): a point 22 px beside its centre still lands on the button
      const box = await page.locator("[data-filter-clear]").boundingBox();
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-filter-clear]") !== null, [box.x + box.width / 2 + 22, box.y + box.height / 2]);
      assert.equal(hit, true, "22 px off the centre is still the ×");
      const miss = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-filter-clear]") !== null, [box.x + box.width / 2 + 30, box.y + box.height / 2]);
      assert.equal(miss, false, "30 px off the centre is outside the 48 px area");
      await page.click('[data-tab="2"]');
      await tile.focus();
      await page.keyboard.press(" ");
      assert.equal(await tile.getAttribute("aria-pressed"), "false", "Space on the active tile clears it");
      assert.equal(await page.locator("[data-mgrid] .mcard:not([hidden])").count(), 3);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("016: each confirm card has its own comment capped at 500 (no counter any more)", async () => {
    const env = await salonPage(browser, "wiz-cmt-0001");
    try {
      const { page } = env;
      await toConfirm(page, "501110031");
      const cards = page.locator("#salon-cards [data-appt]");
      const areas = cards.locator("textarea");
      assert.equal(await areas.count(), 2);
      for (let i = 0; i < 2; i++) assert.equal(await areas.nth(i).getAttribute("maxlength"), "500");
      await areas.nth(0).fill("а".repeat(120));
      assert.equal(await page.locator("[data-appt-counter]").count(), 0, "the counter is gone");
      assert.equal(await areas.nth(1).inputValue(), "", "the other card's comment is untouched");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("audit cycle 1: a lost answer, a frozen identity, a lean page", () => {
  test("the POST is accepted but its answer is lost: no «change time», the retry re-sends the SAME slot, a 409 on it means «check your SMS»", async () => {
    const slug = "wiz-ambig-0001";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      let dropped = false;
      await env.context.route(`${MOCK_API}/api/v1/book/s/${slug}/masters/${M2.id}/booking`, async (route) => {
        if (dropped) return route.fallback();
        dropped = true;
        await route.fetch(); // the backend books...
        return route.abort("failed"); // ...and the answer never arrives
      });
      await toConfirm(page, "501140001");
      await page.click("#cta-confirm");
      const second = page.locator("#salon-cards [data-appt]").nth(1);
      await second.locator("[data-appt-error]:not([hidden])").waitFor();
      const msg = /Не вдалося підтвердити запис до Ірина Мельник\. Перевірте SMS або посилання для скасування, перш ніж записуватися ще раз\./;
      assert.match(await text(second.locator("[data-appt-error]")), msg);
      assert.equal(await second.locator("[data-appt-change]").isHidden(), true, "no change-time for an uncertain booking");
      assert.equal(await page.locator("#cta-confirm").innerText(), "Спробувати знову");
      await page.click("#cta-confirm"); // the same slot again: the backend says it is taken (by the lost request)
      await page.waitForFunction(() => document.querySelector("#cta-confirm").innerText === "Спробувати знову" && !document.querySelector("#cta-confirm").disabled);
      assert.match(await text(second.locator("[data-appt-error]")), msg, "a 409 on the retry is the same «check your SMS» message");
      assert.equal(await second.locator("[data-appt-change]").isHidden(), true);
      const posts = callsTo(await mockLog(), "POST", `/book/s/${slug}/masters/`);
      const m2 = posts.filter((p) => p.path.includes(M2.id));
      assert.equal(posts.filter((p) => p.path.includes(M1.id)).length, 1, "master 1 is booked once");
      assert.equal(m2.length, 2);
      assert.equal(m2[0].body.startsAt, m2[1].body.startsAt, "never a different time for an uncertain booking");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("one master booked, then 401: the code step has no way back, the phone cannot be edited, Back never reaches the contact step", async () => {
    const env = await salonPage(browser, "wiz-c401-0001");
    try {
      const { page } = env;
      await toConfirm(page, "501140002");
      await page.click("#cta-confirm");
      await page.waitForSelector("[data-screen=otp]:not([hidden])");
      assert.equal(await page.locator("#otp-session").isVisible(), true);
      assert.equal(await page.locator("[data-screen=otp] [data-back]").isHidden(), true, "no back arrow on the code step");
      assert.equal(await page.locator("#phone").evaluate((e) => e.readOnly), true, "the phone is frozen");
      assert.equal(await page.locator("#name").evaluate((e) => e.readOnly && document.querySelector("#surname").readOnly), true);
      await page.goBack();
      assert.equal(await page.locator("[data-screen=contact]").isHidden(), true, "Back does not reopen the contact step");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("the guest token does not survive the page being hidden: the next confirm asks for the code again and posts nothing", async () => {
    const slug = "wiz-hide-0001";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      await toConfirm(page, "501140003");
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.click("#cta-confirm");
      await page.waitForSelector("[data-screen=otp]:not([hidden])");
      assert.equal(await page.locator("#otp-session").isVisible(), true);
      assert.equal(callsTo(await mockLog(), "POST", `/book/s/${slug}/masters/`).length, 0, "nothing was posted without a token");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("the next master's days are fetched before their page opens; a day's free times are fetched once", async () => {
    const slug = "wiz-pre-0001";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      await pickServices(page, S2, S3);
      await page.click("#cta-services");
      await toggleMaster(page, M1);
      await toggleMaster(page, M2);
      await clickAndLoadDays(page, "#cta-masters");
      await page.waitForTimeout(400);
      assert.ok(callsTo(await mockLog(), "GET", `/book/s/${slug}/masters/${M2.id}/bookable-days`).length >= 1, "master 2's days were requested while master 1's page is open");
      const day = await pickDay(page);
      await page.click("#cta-date");
      await pickSlot(page, 1);
      await page.click("#cta-time"); // master 2: no new request, the calendar is already grey on Mondays
      await page.waitForSelector("[data-screen=date]:not([hidden])");
      const mondays = await days(page, [1]);
      assert.ok(mondays.length > 0 && mondays.every((d) => d.disabled), "master 2's Mondays are off the moment the page opens");
      await scheduleMaster(page, 1);
      // back to the date and forward again: the same day's times come from the cache
      await page.goBack();
      await page.waitForSelector("[data-screen=date]:not([hidden])");
      await page.click("#cta-date");
      await page.waitForSelector("#slots .slot");
      const avail = callsTo(await mockLog(), "GET", `/book/s/${slug}/masters/${M2.id}/availability`);
      assert.equal(avail.length, 1, "one availability request for that master and day");
      assert.ok(day);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("prefers-reduced-motion: the success step is shown at once (no reveal animation), every step visible", async () => {
    const env = await salonPage(browser, "wiz-rm-0001", { reducedMotion: "reduce" });
    try {
      const { page } = env;
      await toConfirm(page, "501140004");
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-list [data-done]", { state: "visible" });
      const r = await page.evaluate(() => [...document.querySelectorAll("[data-screen=done] .reveal")].map((e) => [getComputedStyle(e).animationName, getComputedStyle(e).opacity]));
      assert.ok(r.length >= 4, "the reveal elements exist");
      for (const [anim, opacity] of r) {
        assert.equal(anim, "none");
        assert.equal(opacity, "1");
      }
      assert.equal(await page.locator("#done-list").isVisible(), true);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("the steps fragment is never indexed: noindex header, robots.txt, not in the sitemap", async () => {
    const res = await get("/book-steps/salon");
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
    assert.match(res.body, /data-screen="masters"/);
    assert.match((await get("/robots.txt")).body, /Disallow: \/book-steps\//);
    assert.equal((await get("/sitemap-0.xml")).body.includes("book-steps"), false);
  });
  test("the wizard data cannot be loaded: a message under the button, no half-open wizard, the next tap works", async () => {
    const slug = "wiz-fail-0001";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      const handler = (route) => route.abort("failed");
      await env.context.route(`${MOCK_API}/api/v1/book/s/${slug}/info`, handler);
      await page.click("#book-cta");
      await page.locator("#book-cta-error").waitFor();
      assert.match(await text(page.locator("#book-cta-error")), /Не вдалося завантажити дані/);
      assert.equal(await page.locator("[data-screen=services]").count(), 0);
      await env.context.unroute(`${MOCK_API}/api/v1/book/s/${slug}/info`, handler);
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      assert.equal(await page.locator("#book-cta-error").count(), 0);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a service name with «$&» reaches the filter chip verbatim", async () => {
    const env = await salonPage(browser, "wiz-dollar-0001");
    try {
      const { page } = env;
      await page.click('[data-tab="2"]');
      await openAll(page, "#panel-2");
      await page.locator(`[data-filter-id="${S3.id}"]`).click();
      await page.waitForSelector("[data-filter-chip]:not([hidden])");
      assert.equal(await text(page.locator("[data-filter-chip]")), "Послуга: Брови $& тест");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("audit cycle 2: gateway timeouts, stale fragment", () => {
  test("a 504 on master 2's POST (backend booked) is uncertain like a dropped answer; a 503 is a plain, definite failure", async () => {
    for (const [status, slug, uncertain] of [[504, "wiz-g504-0001", true], [503, "wiz-g503-0001", false]]) {
      const env = await salonPage(browser, slug);
      try {
        const { page } = env;
        let done = false;
        await env.context.route(`${MOCK_API}/api/v1/book/s/${slug}/masters/${M2.id}/booking`, async (route) => {
          if (done) return route.fallback();
          done = true;
          if (status === 504) await route.fetch(); // the backend books, the answer is a gateway timeout
          return route.fulfill({ status, contentType: "text/plain", body: "x" });
        });
        await toConfirm(page, status === 504 ? "501150001" : "501150002");
        await page.click("#cta-confirm");
        const second = page.locator("#salon-cards [data-appt]").nth(1);
        await second.locator("[data-appt-error]:not([hidden])").waitFor();
        const msg = await text(second.locator("[data-appt-error]"));
        assert.equal(/Перевірте SMS або посилання для скасування/.test(msg), uncertain, `${status}: ${msg}`);
        if (!uncertain) assert.match(msg, /Запис тимчасово недоступний/);
        noProblems(env);
      } finally {
        await env.context.close();
      }
    }
  });
  test("a fragment from another deploy (no templates) is refetched once bypassing the cache, and the wizard opens", async () => {
    const env = await salonPage(browser, "wiz-stale-0001");
    try {
      const { page } = env;
      let n = 0;
      await env.context.route(`${BASE}/book-steps/salon`, (route) => (++n === 1 ? route.fulfill({ status: 200, contentType: "text/html", body: "<p>old deploy</p>" }) : route.fallback()));
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      assert.equal(n, 2, "one refetch");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("audit cycle 3: the uncertain booking survives a reload (sessionStorage marker, no personal data)", () => {
  const KEY = (slug) => `bk-unsure:salon:${slug}`;
  const stored = (page, slug) => page.evaluate((k) => sessionStorage.getItem(k), KEY(slug));
  async function lose(env, slug, { commit = true } = {}) {
    let done = false;
    await env.context.route(`${MOCK_API}/api/v1/book/s/${slug}/masters/${M2.id}/booking`, async (route) => {
      if (done) return route.fallback();
      done = true;
      if (commit) {
        await route.fetch();
        return route.fulfill({ status: 504, contentType: "text/plain", body: "gateway timeout" });
      }
      return route.abort("failed");
    });
  }
  test("a 504 on master 2 stores the master, the slot and a label (no phone, name, note, token); a reload shows the notice naming the master; «Зрозуміло» clears it", async () => {
    const slug = "wiz-mark-0001";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      await lose(env, slug);
      await toConfirm(page, "501160001");
      await page.locator("#salon-cards [data-appt]").nth(1).locator("textarea").fill("Секретна нотатка");
      await page.click("#cta-confirm");
      await page.locator("#salon-cards [data-appt]").nth(1).locator("[data-appt-error]:not([hidden])").waitFor();
      const raw = await stored(page, slug);
      const m = JSON.parse(raw);
      assert.deepEqual(Object.keys(m).sort(), ["at", "label", "masterId", "slotStartIso"]);
      assert.equal(m.masterId, M2.id);
      assert.match(m.label, /Ірина Мельник/);
      for (const secret of ["501160001", "+380", "Марина", "Коваленко", "Секретна", "guest-token", "123456"]) assert.equal(raw.includes(secret), false, `the marker must not contain «${secret}»`);
      await page.reload({ waitUntil: "load" });
      await page.locator("#unsure-note").waitFor();
      assert.match(await text(page.locator("#unsure-note")), /Можливо, ви вже записані на .+Ірина Мельник\. Перевірте SMS перед новим записом\./);
      await page.getByRole("button", { name: "Зрозуміло" }).click();
      assert.equal(await page.locator("#unsure-note").count(), 0);
      assert.equal(await stored(page, slug), null);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a confirmed booking of that master clears the marker", async () => {
    const slug = "wiz-mark-0002";
    const env = await salonPage(browser, slug);
    try {
      const { page } = env;
      await lose(env, slug, { commit: false });
      await toConfirm(page, "501160002");
      await page.click("#cta-confirm");
      await page.locator("#salon-cards [data-appt]").nth(1).locator("[data-appt-error]:not([hidden])").waitFor();
      assert.ok(await stored(page, slug));
      await page.waitForFunction(() => !document.querySelector("#cta-confirm").disabled);
      await page.click("#cta-confirm");
      await page.waitForSelector("#done-list [data-done]", { state: "visible" });
      assert.equal(await stored(page, slug), null);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("a marker older than 15 minutes shows nothing and is removed; a fresh one shows the notice", async () => {
    const slug = "wiz-mark-0003";
    for (const [age, shown] of [[16 * 60_000, false], [60_000, true]]) {
      const env = await salonPage(browser, slug, { init: `try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); sessionStorage.setItem(${JSON.stringify(KEY(slug))}, JSON.stringify({ masterId: ${JSON.stringify(M2.id)}, slotStartIso: "2030-01-02T10:00:00+02:00", label: "вівторок, 2 січня, 10:00, Ірина Мельник", at: Date.now() - ${age} })); } } catch {}` });
      try {
        const { page } = env;
        await page.reload({ waitUntil: "load" });
        await page.waitForTimeout(300);
        assert.equal(await page.locator("#unsure-note").count(), shown ? 1 : 0, `age ${age / 60000} min`);
        if (!shown) assert.equal(await stored(page, slug), null);
        noProblems(env);
      } finally {
        await env.context.close();
      }
    }
  });
  test("with storage blocked the salon page and the wizard still work", async () => {
    const env = await salonPage(browser, "wiz-mark-0004", { init: `Object.defineProperty(window, "sessionStorage", { get() { throw new Error("blocked"); } });` });
    try {
      const { page } = env;
      await page.click("#book-cta");
      await page.waitForSelector("[data-screen=services]:not([hidden])");
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
  test("salon: the notice is laid over the page (CLS <= 0.005 at 360 and 1280 px), «Зрозуміло» moves the focus to the heading, a 10 KB label shows nothing and the key goes", async () => {
    const slug = "wiz-mark-0005";
    const seed = (label) => `try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); sessionStorage.setItem(${JSON.stringify(KEY(slug))}, JSON.stringify({ masterId: ${JSON.stringify(M2.id)}, slotStartIso: "2030-01-02T10:00:00+02:00", label: ${JSON.stringify(label)}, at: Date.now() - 1000 })); } } catch {}`;
    // Counts only the shifts from the moment the notice is inserted: what the notice itself causes. A font swap while the page is still
// loading (before the script that shows the notice has even run) is the page's own load shift, not the notice's, and depends on machine load.
    const CLS = `window.__cls = 0; window.__noteAt = Infinity; new MutationObserver(() => { if (window.__noteAt === Infinity && document.getElementById("unsure-note")) window.__noteAt = performance.now(); }).observe(document, { childList: true, subtree: true }); new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput && e.startTime >= window.__noteAt) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });`;
    for (const width of [360, 1280]) {
      const env = await salonPage(browser, slug, { width, init: CLS + seed("вівторок, 2 січня, 10:00, Ірина Мельник") });
      try {
        const { page } = env;
        await page.locator("#unsure-note").waitFor();
        await page.waitForLoadState("networkidle");
        // settle: fonts loaded, then two painted frames, so any late layout-shift entry is already queued before it is read (threshold unchanged)
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        });
        await page.waitForTimeout(300);
        assert.ok((await page.evaluate(() => window.__cls)) <= 0.005, `CLS at ${width}px`);
        if (width === 360) {
          await page.getByRole("button", { name: "Зрозуміло" }).focus();
          await page.keyboard.press("Enter");
          assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
        }
        noProblems(env);
      } finally {
        await env.context.close();
      }
    }
    const env = await salonPage(browser, "wiz-mark-0006", { init: seed("а".repeat(10_000)).replace(KEY(slug), KEY("wiz-mark-0006")) });
    try {
      await env.page.waitForTimeout(300);
      assert.equal(await env.page.locator("#unsure-note").count(), 0);
      assert.equal(await stored(env.page, "wiz-mark-0006"), null);
      noProblems(env);
    } finally {
      await env.context.close();
    }
  });
});

describe("old links: 410 BOOKING_LINK_RETIRED", () => {
  for (const path of ["/book/retired-bbbb", "/book/s/retiredsalon-bbbb"]) {
    test(`${path}: 410, noindex, the «Посилання на запис більше не активне» page with a way home, no explanatory sentence`, async () => {
      const res = await get(path);
      assert.equal(res.status, 410);
      assert.equal(res.headers["x-robots-tag"], "noindex, nofollow");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.match(res.body, /<h1[^>]*>Посилання на запис більше не активне<\/h1>/);
      assert.equal(res.body.includes("замінили це посилання") || res.body.includes("більше не дійсне"), false, "the old title and the removed sentence are gone");
      assert.match(res.body, /<title>Посилання на запис більше не активне — Beautica<\/title>/);
      assert.match(res.body, /href="\/"[^>]*>[\s\S]*?На головну/);
      assert.equal(/application\/ld\+json|rel="canonical"|data-book-root/.test(res.body), false);
    });
  }
});

test("the base URL is local (the suite never talks to the real site)", () => assert.match(BASE, /^http:\/\/127\.0\.0\.1:/));
