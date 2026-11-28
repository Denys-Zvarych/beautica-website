// Phase 051 QA (privacy 2.2, 2026-11-27: providers rate guests/walk-ins by phone; anonymous provider comments about clients). No server, no browser,
// no network: reads dist/client, the policy source and docs/claims.md. Runs in `npm run test:static`.
//   1. /privacy shows version 2.2 / 2026-11-27 and PRIVACY_POLICY_VERSION equals it
//   2. every approved clause (phase 051 scope 1-5) is on the BUILT page, in the right section
//   3. the legal-bases bullet sits directly before the complaints bullet and routes objections to privacy@
//   4. the ledger has a row for each new statement and the row's anchor is on the page
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");
const html = readFileSync(join(DIST, "privacy.html"), "utf8");
const text = (s) => s.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;|&apos;|\u2019/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Visible text of one policy section, from its H2 id to the next H2. */
const section = (id) => text(html.split(new RegExp(`<h2[^>]*\\bid="${id}"`))[1]?.split(/<h2[\s>]/)[0] ?? "");
const flat = (s) => s.replace(/\s+/g, " ");

describe("/privacy is policy 2.2 of 2026-11-27", () => {
  test("PRIVACY_POLICY_VERSION is 2026-11-27 and the page shows «Версія 2.2» with that date", () => {
    assert.equal(PRIVACY_POLICY_VERSION, "2026-11-27");
    assert.match(text(html), /Версія 2\.2/);
    assert.match(html, /<time datetime="2026-11-27"/);
  });
});

describe("§2 «Відгуки та оцінки» carries the guest / walk-in rating and the anonymous-comment clauses", () => {
  const data = section("data");
  test("guests and walk-ins can be rated, keyed to their phone, on the legitimate-interest basis", () => {
    for (const p of ["оцінити й клієнта без акаунта (гостя, який записався за посиланням, або клієнта, якого майстер додав сам)", "оцінка прив'язується до номера телефону", "законний інтерес майстра чи салону (облік неявок і поведінки клієнтів)", "клієнт без акаунта політику не приймав"]) assert.ok(data.includes(p), `§2 lost «${p}»`);
  });
  test("a person who registers with that phone sees their summary rating", () => {
    assert.ok(data.includes("Коли така людина реєструється в застосунку з цим номером, вона бачить свій підсумковий рейтинг."));
  });
  test("the client does not see comments in the app; other providers see rating + comments anonymously, with the visit month only", () => {
    assert.ok(data.includes("Коментар майстра чи салону про клієнта клієнт у застосунку не бачить: він бачить лише власний підсумковий рейтинг."));
    assert.ok(data.includes("у картці клієнта підсумковий рейтинг, а також оцінки з коментарями — анонімно, без назви салону чи імені майстра, лише з місяцем візиту."));
    assert.ok(!data.includes("в картці запису"), "the rating is on the client card, not the booking card");
  });
  test("the re-identification warning follows the anonymity sentence directly", () => {
    assert.ok(flat(data).includes("лише з місяцем візиту. Сам текст коментаря може містити деталі, за якими автора можна впізнати."));
  });
  test("the client gets a copy of the data, comments included, on a support request", () => {
    assert.ok(data.includes("Копію даних про себе, зокрема цих коментарів, клієнт може отримати на запит до служби підтримки"));
  });
});

describe("§5 legal bases: the new bullet and its privacy@ objection route", () => {
  const li = [...(html.split(/<h2[^>]*\bid="purposes"/)[1]?.split(/<h2[\s>]/)[0] ?? "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  const at = li.findIndex((x) => text(x).includes("Оцінки й коментарі майстрів і салонів про клієнтів"));
  test("the bullet exists in §5 and states the legitimate interest", () => {
    assert.ok(at >= 0, "§5 has no bullet «Оцінки й коментарі майстрів і салонів про клієнтів»");
    const t = text(li[at]);
    assert.ok(t.includes("оцінки яких прив'язані до номера телефону, і показ коментарів іншим майстрам і салонам без імені автора"));
    assert.ok(t.includes("законний інтерес майстрів і салонів в обліку неявок і поведінки клієнтів"));
  });
  test("it lets the person object or ask for a copy at privacy@beautica.app with their phone, identity checked as in §3", () => {
    const t = text(li[at]);
    assert.match(li[at], /href="mailto:privacy@beautica\.app"/);
    assert.ok(t.includes("заперечити проти такої обробки або попросити копію цих даних"));
    assert.ok(t.includes("вказавши свій номер телефону; особу підтверджуємо за номером, як описано в розділі 3."));
  });
  test("it sits directly before «Скарги, модерація й блокування клієнтів»", () => {
    assert.ok(text(li[at + 1] ?? "").includes("Скарги, модерація й блокування клієнтів"), "the bullet is not directly before the complaints bullet");
  });
});

describe("§6 recipients and §8 retention", () => {
  test("§6: other providers with the client in their list also see the summary rating and the comments without the author's name, cross-referencing §2", () => {
    const r = section("recipients");
    assert.ok(r.includes("Інші майстри та салони, які мають клієнта у своєму списку клієнтів, бачать також його підсумковий рейтинг і коментарі про нього без імені автора (розділ 2, «Відгуки та оцінки»)."));
  });
  test("§6: the phone is «підтверджений через SMS» only for registered clients (walk-in phones are typed by the provider)", () => {
    const r = section("recipients");
    assert.ok(r.includes("номер телефону клієнта (для зареєстрованих — підтверджений через SMS)"));
    assert.ok(!r.includes("підтверджений номер телефону"), "the old unconditional «підтверджений номер телефону» is back");
  });
  test("§8: ratings of a guest / account-less client are deleted when the guest data is anonymised (§3)", () => {
    assert.ok(section("retention").includes("Оцінки гостя та клієнта без акаунта, які поставили майстри, видаляються, коли знеособлюються його гостьові дані (розділ 3)."));
  });
});

describe("docs/claims.md has a row for each new statement", () => {
  const rows = read("docs/claims.md").split("\n").filter((l) => l.startsWith("|") && !/^\|\s*(claim|-)/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  for (const [needle, anchor] of [["guests and walk-ins are rated by phone", "privacy#data"], ["providers see comments about a client anonymously", "privacy#recipients"], ["guest and walk-in ratings are deleted", "privacy#retention"]]) {
    test(`row «${needle}» exists, is live, and its anchor #${anchor.split("#")[1]} is on the page`, () => {
      const r = rows.find((x) => x[0].includes(needle));
      assert.ok(r, `no ledger row «${needle}»`);
      assert.equal(r[1], anchor);
      assert.equal(r[3], "live");
      assert.ok(html.includes(`id="${anchor.split("#")[1]}"`));
    });
  }
});
