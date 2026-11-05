// Phase 021 QA (privacy 1.4, section «Нагадування в Telegram (за вашим вибором)»). No server, no browser, no network: reads dist/client,
// the policy source, docs/claims.md and (when checked out) the backend. Runs in `npm run test:static` and `npm run test:contract`.
//   1. /privacy: the new H3 anchor exists and sits inside §3; the TOC still lists every H2 (and only them)
//   2. the policy's Telegram facts == the backend: message kinds, SMS-only kinds, HMAC hash, no raw phone, retention 12 / 12 / <= 2 days
//   3. every `Telegram` ledger row exists and its cited line still says what the row claims
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { BACKEND_DIR, backendGate, javaSource, siblingPath } from "./helpers/backend.mjs";

const gate = backendGate();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");
const html = readFileSync(join(DIST, "privacy.html"), "utf8");
const md = read("src/content/legal/uk/privacy.md");
const ANCHOR = "нагадування-в-telegram-за-вашим-вибором";
const HEADING = "Нагадування в Telegram (за вашим вибором)";
/** The Telegram subsection of the policy: from its H3 to the next heading. */
const section = md.slice(md.indexOf(`### ${HEADING}`)).split(/\n(?=##+ )/)[0];
const bullet = (label) => section.split("\n").find((l) => l.startsWith(`- **${label}`)) ?? "";
const ledger = read("docs/claims.md").split("\n").filter((l) => l.startsWith("|") && !/^\|\s*(claim|-)/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
const tgRows = ledger.filter((r) => r[0].startsWith("Telegram"));
const rowFor = (needle) => {
  const r = tgRows.find((x) => x[0].includes(needle));
  assert.ok(r, `no ledger row «Telegram … ${needle}»`);
  const [, file, line] = /^`(.+):(\d+)`$/.exec(r[2]);
  const abs = siblingPath(file) ?? resolve(ROOT, file);
  return { r, file, text: existsSync(abs) ? read0(abs).split("\n")[Number(line) - 1] : undefined };
};
const read0 = (abs) => readFileSync(abs, "utf8");

describe("/privacy: the Telegram subsection is reachable and the table of contents is intact", () => {
  test("the H3 «Нагадування в Telegram (за вашим вибором)» has the id #" + ANCHOR, () => {
    assert.match(html, new RegExp(`<h3[^>]*\\bid="${ANCHOR}"[^>]*>\\s*${HEADING.replace(/[()]/g, "\\$&")}\\s*</h3>`));
  });
  test("the H3 is inside §3 (between #guest and #analytics)", () => {
    const at = (id) => html.indexOf(`id="${id}"`);
    assert.ok(at("guest") > 0 && at(ANCHOR) > at("guest") && at(ANCHOR) < at("analytics"), "H3 is not between §3 and §4");
  });
  test("the TOC lists every H2 of privacy.md, in order, each link resolving to an id on the page; the H3 is not a TOC entry", () => {
    const h2 = [...md.matchAll(/^## (.+?) \{#([\w-]+)\}$/gm)].map((m) => [m[2], m[1]]);
    assert.ok(h2.length >= 13, `parsed ${h2.length} H2 headings: the parser is broken`);
    const toc = /<ol class="toc"[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? "";
    const links = [...toc.matchAll(/<a[^>]*href="#([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(links.map((l) => l[0]), h2.map((h) => h[0]), "TOC anchors differ from the policy's H2 list");
    for (const [id, text] of h2) assert.ok(links.some((l) => l[1].endsWith(text)), `TOC text for ${id} missing`);
    for (const [id] of links) assert.ok(html.includes(`id="${id}"`), `TOC link #${id} has no target`);
    assert.ok(!links.some((l) => l[0] === ANCHOR), "the H3 must not be a TOC entry");
  });
});

describe("the policy's Telegram facts equal the backend's", gate, () => {
  const KINDS = { GUEST_CONFIRMATION: "підтвердження запису з посиланням для скасування", WALK_IN_CONFIRMATION: "запису, який вам зробив майстер", GUEST_REMINDER_24H: "за 24 год", GUEST_REMINDER_2H: "за 2 год", GUEST_PROVIDER_CANCELLATION: "скасування або перенесення запису майстром чи салоном", GUEST_PROVIDER_RESCHEDULE: "перенесення запису майстром чи салоном", GUEST_REVIEW_INVITE: "запрошення залишити відгук" };
  test("the messages the policy sends via Telegram are exactly the GuestMessageKind values", () => {
    const enumBody = /GuestMessageKind\s*\{([\s\S]*?);/.exec(javaSource("GuestMessageKind").replace(/\/\*[\s\S]*?\*\//g, ""))[1];
    const kinds = [...enumBody.matchAll(/\b([A-Z][A-Z0-9_]+)\(/g)].map((m) => m[1]);
    assert.deepEqual(kinds.sort(), Object.keys(KINDS).sort(), "the backend's Telegram-capable kinds changed: update the policy, the ledger and this map");
    const sent = bullet("Що надсилаємо в Telegram").split("Код підтвердження")[0];
    for (const [k, phrase] of Object.entries(KINDS)) assert.ok(sent.includes(phrase), `policy no longer lists ${k} («${phrase}»)`);
  });
  test("the policy says only the phone code is SMS-only and the guest's own cancellation sends nothing: neither is a Telegram kind", () => {
    const smsOnly = bullet("Що надсилаємо в Telegram").split("Код підтвердження")[1] ?? "";
    for (const phrase of ["лише SMS", "скасування, яке ви зробили самі, ми не надсилаємо"]) assert.ok(smsOnly.includes(phrase), `policy lost the SMS-only item «${phrase}»`);
    assert.doesNotMatch(javaSource("GuestMessageKind"), /^\s*GUEST_(OTP|CANCELLATION)\w*\(/m, "the phone code or the guest's own cancellation became a Telegram kind: update the policy");
  });
  test("the link is keyed by an HMAC-SHA-256 of the phone, as the policy says", () => {
    assert.match(bullet("Що ми зберігаємо"), /HMAC-SHA-256/);
    assert.match(javaSource("PhoneHasher"), /ALGORITHM = "HmacSHA256"/);
  });
  test("neither Telegram table has a raw phone column: only phone_hash", () => {
    for (const type of ["TelegramLink", "TelegramLinkToken"]) {
      const cols = [...javaSource(type).matchAll(/@Column\(name = "(\w+)"/g)].map((m) => m[1]).filter((c) => /phone/.test(c));
      assert.deepEqual(cols, ["phone_hash"], `${type} stores ${cols}: the policy says the number is never stored`);
    }
    assert.match(bullet("Що ми зберігаємо"), /Сам номер у записі про підключення не зберігається/);
    assert.match(bullet("Чого ми не зберігаємо"), /номер, яким ви поділилися в боті/);
  });
  test("retention: the policy says 12 months after the last visit (= guest-pii-retention.retention-months), 12 months after a block, link codes <= 2 days", () => {
    const yml = read0(join(BACKEND_DIR, "src/main/resources/application.yml"));
    assert.equal(Number(/guest-pii-retention:[\s\S]*?retention-months:\s*(\d+)/.exec(yml)[1]), 12);
    const r = section.split("**Скільки зберігаємо:**")[1].split("**Чого ми не зберігаємо")[0];
    assert.match(r, /за номером минуло \*\*12 місяців без записів\*\*/);
    assert.match(r, /заблокували бота[^\n]*\*\*12 місяців\*\* після блокування/);
    assert.match(r, /не пізніше ніж через 2 доби\*\* після закінчення строку дії/);
    assert.match(md, /^- \*\*Підключення Telegram\*\* — разом із гостьовим записом \(12 місяців[^\n]*12 місяців після блокування бота[^\n]*не пізніше ніж через 2 доби/m, "§8 retention list disagrees with §3");
  });
});

describe("the Telegram ledger rows still point at the line they claim", gate, () => {
  const cases = [
    ["24 h reminder", /GUEST_REMINDER_24H\(/],
    ["2 h reminder", /GUEST_REMINDER_2H\(/],
    ["cancellation by the master", /GUEST_PROVIDER_CANCELLATION\(/],
    ["reschedule by the master", /GUEST_PROVIDER_RESCHEDULE\(/],
    ["review invitation", /GUEST_REVIEW_INVITE\(/],
    ["HMAC-SHA-256", /"HmacSHA256"/],
    ["no raw phone", /byte\[\]\s+phoneHash/],
    ["12 months after the last visit", /retention-months:\s*12\b/],
  ];
  for (const [needle, re] of cases)
    test(`row «${needle}»: the cited source line matches ${re}`, () => {
      const { r, text } = rowFor(needle);
      assert.equal(r[3], "live");
      assert.match(text ?? "", re, `${r[2]} no longer says that`);
    });
  test("the two retention promises whose job is NOT shipped (phase 409 D2/D4) are not-live rows, so the gap stays listed", () => {
    for (const needle of ["after the bot was blocked", "at most 2 days"]) assert.equal(rowFor(needle).r[3], "not-live", `${needle}: flip to live only when backend 409 ships and the row cites code`);
  });
});

describe("the unlink label is one string across the site copy, the policy and the bot button", gate, () => {
  const LABEL = "Відписатися від Telegram";
  const uk = JSON.parse(read("src/i18n/uk.json"));
  const find = (o, k) => (o && typeof o === "object" ? (k in o ? o[k] : Object.values(o).map((v) => find(v, k)).find((v) => v !== undefined)) : undefined);
  test("uk.json backToSms", () => assert.equal(find(uk, "backToSms"), LABEL));
  test("privacy.md quotes the bot button label", () => assert.ok(read("src/content/legal/uk/privacy.md").includes(`«${LABEL}»`)));
  test("backend TelegramBotReplies.UNLINK_BUTTON_TEXT", () => {
    const m = /\bUNLINK_BUTTON_TEXT\s*=\s*"([^"]*)"/.exec(javaSource("TelegramBotReplies"));
    assert.ok(m, "constant not found");
    assert.equal(m[1], LABEL);
  });
});
