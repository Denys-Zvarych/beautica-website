// Phase 008/009 QA: the numbers the booking pages state (2-hour cancel rule, 60-day window, 10-service cap, comment limit) are
// compared with the backend / app source they come from. scripts/check-claims.mjs only proves a ledger row's line is IN RANGE; this
// proves the line still says what the page says, and that every page copy of the number agrees with the backend value.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, uk } from "./helpers/env.mjs";
import { BACKEND_DIR, backendGate, javaInt, mobileGate, siblingPath } from "./helpers/backend.mjs";

const gate = backendGate();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const ledgerRows = read("docs/claims.md").split("\n").filter((l) => l.startsWith("|") && !/^\|\s*(claim|-)/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
const sourceLine = (cells) => {
  const m = /^`(.+):(\d+)`$/.exec(cells[2]);
  const file = siblingPath(m[1]) ?? resolve(ROOT, m[1]);
  return { file: m[1], absent: !mobileGate(file), line: existsSync(file) ? readFileSync(file, "utf8").split("\n")[Number(m[2]) - 1] : "" };
};
const hours = (s) => Number(/(\d+)\s*(?:год|hour)/.exec(s)?.[1]);
const flatten = (o) => Object.values(o).flatMap((v) => (typeof v === "object" && v ? flatten(v) : [String(v)]));

describe("stated numbers equal the backend's", gate, () => {
  test("cancel window: every place the site says «N годин» equals BookingSmsProperties.cancelWindowHours", () => {
    const backend = javaInt("BookingSmsProperties", "cancelWindowHours");
    const copy = [
      ["uk.json book.done.cancelRule", uk.book.done.cancelRule],
      ["uk.json cancel.closedText", uk.cancel.closedText],
      ["privacy.md §3", read("src/content/legal/uk/privacy.md").split("\n").find((l) => /не пізніше ніж за \d+ годин/.test(l))],
    ];
    for (const [where, text] of copy) {
      assert.ok(text, `${where}: the sentence is gone`);
      assert.equal(hours(text), backend, `${where} says ${hours(text)} h, the backend ${backend} h`);
    }
  });
  test("booking window: calendar WINDOW_DAYS equals availabilityMaxDays", () => {
    assert.equal(Number(/WINDOW_DAYS = (\d+)/.exec(read("src/scripts/booking/calendar.ts"))[1]), javaInt("BookingSmsProperties", "availabilityMaxDays"));
  });
  test("visit size: the picker's cap equals MAX_SERVICES_PER_VISIT", () => {
    assert.equal(Number(/st\.picked\.size >= (\d+)\)/.exec(read("src/scripts/booking/app.ts"))[1]), javaInt("SlotCalculationService", "MAX_SERVICES_PER_VISIT"));
  });
  test("no user-visible copy states a window or cap the code does not have", () => {
    const strings = flatten(uk.book).join("\n");
    for (const m of strings.matchAll(/(\d+)\s*(?:днів|дні|послуг)/g)) assert.ok([60, 10].includes(Number(m[1])), `copy mentions «${m[0]}»: add a claims row and a pin`);
  });
});

describe("the ledger rows added for the booking pages still point at the line they claim", gate, () => {
  const pin = (needle) => ledgerRows.find((r) => r[0].startsWith("Guest booking") && r[3] === "live" && r[1].includes(needle));
  const cases = [
    ["src:src/i18n/uk.json", /cancelWindowHours\s*=\s*2\b/],
    ["calendar.ts", /availabilityMaxDays\s*=\s*60\b/],
    ["app.ts#st.picked", /MAX_SERVICES_PER_VISIT\s*=\s*10\b/],
    ["BookingFlow.astro", /_maxComment\s*=\s*500\b/],
  ];
  for (const [needle, re] of cases)
    test(`row «${needle}»: the cited source line matches ${re}`, (t) => {
      const row = pin(needle);
      assert.ok(row, `no ledger row anchored at ${needle}`);
      const { file, line, absent } = sourceLine(row);
      if (absent) return t.skip("that sibling repo (mobile) is not checked out");
      assert.match(line, re, `${file}: the cited line no longer says that (line moved or value changed): "${line.trim()}"`);
    });
  test("every sibling-repo source line in the ledger is code, not a blank or a comment", () => {
    for (const r of ledgerRows) {
      const m = /^`(\.\.\/.+):(\d+)`$/.exec(r[2]);
      if (!m || r[3] !== "live") continue; // a not-live row may cite the comment that documents the gap
      const file = siblingPath(m[1]);
      if (!file || !existsSync(file)) continue; // not in this (sparse) checkout: the pinned rows above are the ones that must be present
      const text = readFileSync(file, "utf8").split("\n")[Number(m[2]) - 1];
      assert.ok(text && !/^\s*(\/\/|\*|\/\*|\}|$)/.test(text), `${r[0].slice(0, 50)}: ${m[1]}:${m[2]} is blank or a comment`);
    }
  });
});

// Phase 018: the numbers the legal bump states about reports, blocks and guest-review invites, compared with where they live.
// 395-399 are built (backend code is the source); 400-402 are not built yet, so their numbers are pinned to the phase docs
// (../docs/backend-phases) until the code exists: then repoint these to the constants and the ledger rows to not-live -> live.
describe("legal bump (phase 018): stated numbers equal the backend's", gate, () => {
  const privacy = read("src/content/legal/uk/privacy.md");
  const terms = read("src/content/legal/uk/terms.md");
  const be = (rel) => readFileSync(join(BACKEND_DIR, "src/main/java/com/beautica", rel), "utf8");
  const doc = (name) => {
    const dir = resolve(ROOT, "..", "docs", "backend-phases");
    const f = existsSync(dir) ? readdirSync(dir).find((n) => n.startsWith(name)) : undefined;
    return f ? readFileSync(join(dir, f), "utf8") : undefined;
  };
  test("report comment limit: privacy says 500, CreateReportRequest.MAX_COMMENT_LENGTH is 500", () => {
    assert.match(privacy, /необов'язковий коментар \(до 500 символів\)/);
    assert.equal(javaInt("CreateReportRequest", "MAX_COMMENT_LENGTH"), 500);
  });
  test("guest review comment limit: privacy says 2000, CreateReviewRequest allows 2000", () => {
    assert.match(privacy, /коментар \(до 2000 символів\)/);
    assert.match(be("review/dto/CreateReviewRequest.java"), /max = 2000/);
  });
  test("auto-hide threshold: terms say «троє», app.moderation.auto-hide-threshold is 3", () => {
    assert.match(terms, /\(зараз — троє\)/);
    assert.match(be("../../../resources/application.yml"), /auto-hide-threshold:\s*3\b/);
  });
  test("report retention: privacy says 1 year, ContentReportRetentionService.RETENTION_YEARS is 1", () => {
    assert.match(privacy, /скарги зберігаємо ще 1 рік/);
    assert.match(be("moderation/service/ContentReportRetentionService.java"), /RETENTION_YEARS\s*=\s*1\s*;/);
  });
  test("anonymised name: privacy says «Гість», GuestPii.ANONYMISED_NAME is «Гість»", () => {
    assert.match(be("booking/retention/GuestPii.java"), /ANONYMISED_NAME\s*=\s*"Гість"/);
    assert.match(privacy, /змінюються на «Гість»/);
  });
  test("blocks: the registered client keeps no phone (V211 CHECK), the guest keeps hash + last 4", () => {
    assert.match(privacy, /Для клієнта із застосунку це ще й його акаунт\. Для гостя/);
    assert.match(be("../../../resources/db/migration/V211__client_blocks_identity_per_type.sql"), /phone_last4 IS NULL OR phone_hash IS NOT NULL/);
  });
  test("guest-review invite numbers (backend 400-402 docs, code not built yet): 2 h, 21:00-09:00, 10:00, 72 h, 14 d, 30 d", (t) => {
    const d400 = doc("phase-400");
    const d401 = doc("phase-401");
    const d402 = doc("phase-402");
    if (!d400 || !d401 || !d402) return t.skip("docs/backend-phases not checked out");
    assert.match(privacy, /Через 2 години після того/);
    assert.match(d400, /send_after = completedAt \+ 2h/);
    assert.match(privacy, /з 21:00 до 09:00 за київським часом: у такому разі воно надійде о 10:00/);
    assert.match(d400, /\[21:00, 09:00\)[^\n]*10:00/);
    assert.match(privacy, /протягом 3 діб після запланованого часу/);
    assert.match(d400, /72 h after `send_after`/);
    assert.match(privacy, /Посилання діє 14 днів від надсилання/);
    assert.match(d400, /`expires_at = sent_at \+ 14 d`|expires_at = sent_at \+ 14 d/);
    assert.match(privacy, /Кнопка працює 30 днів після надсилання SMS/);
    assert.match(d401, /for 30 days after sending/);
    assert.match(privacy, /видаляється через 30 днів після закінчення дії посилання/);
    assert.match(d402, /30 days after `expires_at`/);
  });
  test("review-page button text in the policy equals uk.json review.optOut", () => {
    assert.ok(privacy.includes(`«${uk.review.optOut}»`), "privacy quotes a button text that is not the page's");
  });
});
