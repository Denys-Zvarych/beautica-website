// Phase 008/009 QA: the numbers the booking pages state (2-hour cancel rule, 60-day window, 10-service cap, comment limit) are
// compared with the backend / app source they come from. scripts/check-claims.mjs only proves a ledger row's line is IN RANGE; this
// proves the line still says what the page says, and that every page copy of the number agrees with the backend value.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, uk } from "./helpers/env.mjs";
import { backendGate, javaInt, mobileGate, siblingPath } from "./helpers/backend.mjs";

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
