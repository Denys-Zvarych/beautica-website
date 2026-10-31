// Phase 025 (browser, mock backend): the compact confirm and done screens fit an iPhone 15 Safari viewport (393 x 660 visible), and their pieces
// are what the design says: merged card, no client row, 2-row comment, sticky CTA; centred success header, one details card, centred calendar link,
// no cancel text / button; exact picker copy. Heights are measured in the real layout, never inferred.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";
import { bookPage, driveTo } from "./helpers/book.mjs";

const W = 393;
const H = 660;
let browser;
before(async () => (browser = await launch()));
after(async () => browser?.close());

const open = (slug) => bookPage(browser, slug, { width: W, height: H, hasTouch: true, isMobile: true });
async function toConfirm(env, name) {
  await driveTo(env.page, "confirm", { contact: { name } });
  await env.page.locator("[data-screen=confirm]:not([hidden]) #confirm-card").waitFor();
}
async function toDone(env) {
  await env.page.click("#cta-confirm");
  await env.page.waitForSelector("#done-card", { state: "visible" });
}
/** Height of everything on the done screen (top of the first element to the bottom of the last), px. */
const doneHeight = (page) =>
  page.evaluate(() => {
    const s = document.querySelector("[data-screen=done]");
    const kids = [...s.querySelectorAll(".hero, .sumcard, .calwrap, #done-reminders:not([hidden])")];
    const top = Math.min(...kids.map((k) => k.getBoundingClientRect().top));
    const bottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
    return { height: bottom - top, scroll: s.querySelector(".body").scrollHeight, client: s.querySelector(".body").clientHeight };
  });

describe("confirm @393x660", () => {
  test("merged card, no client row, 2-row 16 px comment, no counter, CTA pinned to the bottom of the viewport", async () => {
    const env = await open("tgdone-3131");
    try {
      await toConfirm(env, "Компакт");
      const p = env.page;
      assert.equal(await p.locator("[data-screen=confirm] .sumcard").count(), 1, "ONE merged card");
      assert.equal(await p.locator("#c-name, #c-phone, #counter").count(), 0);
      const ta = p.locator("#comment");
      assert.equal(await ta.getAttribute("rows"), "2");
      assert.equal(await ta.evaluate((e) => getComputedStyle(e).fontSize), "16px");
      const card = await p.locator("[data-screen=confirm] .sumcard").boundingBox();
      const txt = (await p.locator("[data-screen=confirm] .sumcard").innerText()).replace(/\s+/g, " ");
      for (const label of ["Коли", "Адреса", "Разом"]) assert.ok(txt.includes(label), `${label} in ${txt}`);
      const cta = await p.locator("#cta-confirm").boundingBox();
      assert.ok(cta.y + cta.height <= H + 0.5 && cta.y + cta.height >= H - 24, `CTA bottom ${cta.y + cta.height} sits at the viewport bottom (${H})`);
      const area = await ta.boundingBox();
      assert.ok(area.y + area.height <= cta.y, "the comment is above the CTA, nothing needs a scroll to reach the button");
      assert.ok(card.y + card.height < cta.y, "card above the CTA");
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
      assert.deepEqual(env.problems.filter((x) => !/status of (409|401|429|503|400)/.test(x)), []);
    } finally {
      await env.context.close();
    }
  });
});

describe("done @393x660", () => {
  test("SMS picker: centred success header, one details card, centred calendar link, no cancel; the whole screen is <= 591 px", async () => {
    const env = await open("tgdone-3131");
    try {
      const p = env.page;
      await toConfirm(env, "Компакт");
      await toDone(env);
      await p.locator("#done-reminders").waitFor({ state: "visible" });
      assert.equal(await p.locator("[data-screen=done] .sumcard").count(), 1, "one details card");
      assert.equal(await p.locator("#done-cancel, [data-done-cancel], [data-screen=done] a[href*='/book/cancel']").count(), 0);
      const done = (await p.locator("[data-screen=done]").innerText()).replace(/\s+/g, " ");
      assert.equal(/Скасувати|не пізніше ніж за 2 години/.test(done), false, done);
      const disc = await p.locator("[data-screen=done] .hero .disc").boundingBox();
      assert.ok(Math.abs(disc.width - 48) <= 1 && Math.abs(disc.height - 48) <= 1, `disc ${disc.width}x${disc.height}`);
      const h2 = await p.locator("[data-screen=done] h2").boundingBox();
      const cal = await p.locator("[data-screen=done] .calbtn").boundingBox();
      for (const [name, b] of [["disc", disc], ["heading", h2], ["calendar link", cal]]) assert.ok(Math.abs(b.x + b.width / 2 - W / 2) <= 2, `${name} centred: ${b.x + b.width / 2}`);
      assert.equal(await p.locator("[data-screen=done] h2").evaluate((e) => Math.round(parseFloat(getComputedStyle(e).fontSize))), 21);
      const m = await doneHeight(p);
      console.log("done SMS height:", Math.round(m.height));
      assert.ok(m.height <= 591, `SMS done ${m.height} px > 591`);
      assert.ok(m.scroll <= m.client + 1 || m.height <= H, "fits the viewport");
      assert.equal(await p.locator("[data-r-connect]").isVisible(), false);
    } finally {
      await env.context.close();
    }
  });

  test("Telegram picker selected: the screen is <= 645 px (hard limit 660), Connect button is 48 px high and only now visible", async () => {
    const env = await open("tgdone-3131");
    try {
      const p = env.page;
      await toConfirm(env, "Компакт");
      await toDone(env);
      await p.locator("#done-reminders").waitFor({ state: "visible" });
      const sms = (await doneHeight(p)).height;
      await p.locator("#done-reminders input[value=telegram]").check({ force: true });
      await p.locator("[data-r-connect]").waitFor({ state: "visible" });
      const connect = await p.locator("[data-r-connect]").boundingBox();
      assert.ok(Math.abs(connect.height - 48) <= 1, `connect ${connect.height}`);
      const m = await doneHeight(p);
      console.log("done Telegram height:", Math.round(m.height), "(SMS", Math.round(sms) + ")");
      assert.ok(m.height <= 645, `Telegram done ${m.height} px > 645`);
      assert.ok(m.height <= H, "hard limit 660");
      // Growth is accepted by design (the picker is the last element; nothing below moves): no reserved Connect slot is asserted.
      assert.ok(m.height >= sms, "Telegram state is never shorter than SMS");
    } finally {
      await env.context.close();
    }
  });
});

describe("picker copy @393", () => {
  test("heading, SMS and Telegram descriptions are exact; the dropped sentence is gone; descriptions share one grid cell", async () => {
    const env = await open("tgdone-3131");
    try {
      const p = env.page;
      await toConfirm(env, "Компакт");
      await toDone(env);
      await p.locator("#done-reminders").waitFor({ state: "visible" });
      assert.equal((await p.locator("#reminders-h").innerText()).trim(), "Куди надсилати нагадування про записи?");
      const labels = await p.locator("#done-reminders .seg label").allInnerTexts();
      assert.deepEqual(labels.map((x) => x.trim()), ["SMS", "Telegram"]);
      const sms = p.locator("[data-r-desc=sms]");
      const tg = p.locator("[data-r-desc=telegram]");
      assert.equal((await sms.innerText()).trim(), "Нагадування прийдуть в SMS на номер, який ви вказали.");
      assert.equal(await tg.evaluate((e) => e.hasAttribute("data-off")), true);
      const before = await p.locator("#reminders-desc").boundingBox();
      await p.locator("#done-reminders input[value=telegram]").check({ force: true });
      assert.equal((await tg.innerText()).trim(), "Відкриється бот Beautica: «Почати» → «Поділитися номером».");
      assert.equal(await sms.evaluate((e) => e.hasAttribute("data-off")), true);
      const after = await p.locator("#reminders-desc").boundingBox();
      assert.ok(Math.abs(after.height - before.height) <= 1 || after.height >= before.height, "stacked descriptions: the block never shrinks when switching");
      assert.equal((await p.locator("#done-reminders").innerText()).includes("Код і підтвердження"), false);
      assert.equal(await p.locator("#done-reminders .seg").getAttribute("role"), "group");
      assert.equal(await p.locator("#done-reminders .seg input[type=radio][name=reminder-channel]").count(), 2);
    } finally {
      await env.context.close();
    }
  });
});
