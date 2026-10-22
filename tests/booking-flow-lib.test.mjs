// Unit tests of the booking-flow modules: calendar (Europe/Kyiv), API error mapping, .ics, phone mask. Phase 009.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addDays, inWindow, kyivToday, maxMonthOffset, monthView, partOfDay, weekdayMon0, WINDOW_DAYS, kyivTime, kyivDay } from "../src/scripts/booking/calendar.ts";
import { failFor, cancelPath } from "../src/scripts/booking/api.ts";
import { buildIcs } from "../src/scripts/booking/ics.ts";
import { formatPhoneGrouped, nationalDigits } from "../src/lib/phone.ts";

describe("calendar (Europe/Kyiv)", () => {
  test("kyivToday uses Kyiv, not UTC: 22:30 UTC on 30 Oct is already 31 Oct in Kyiv (UTC+2, after DST ends 25 Oct)", () => {
    assert.equal(kyivToday(new Date("2026-10-30T22:30:00Z")), "2026-10-31");
    assert.equal(kyivToday(new Date("2026-10-30T21:30:00Z")), "2026-10-30");
  });
  test("addDays crosses DST changes without drifting", () => {
    assert.equal(addDays("2026-10-24", 1), "2026-10-25");
    assert.equal(addDays("2026-10-25", 1), "2026-10-26");
    assert.equal(addDays("2026-03-28", 2), "2026-03-30");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });
  test("window = today ... today + 60", () => {
    assert.equal(inWindow("2026-10-22", "2026-10-22"), true);
    assert.equal(inWindow("2026-10-21", "2026-10-22"), false);
    assert.equal(inWindow(addDays("2026-10-22", WINDOW_DAYS), "2026-10-22"), true);
    assert.equal(inWindow(addDays("2026-10-22", WINDOW_DAYS + 1), "2026-10-22"), false);
  });
  test("Monday-first grid: 1 Oct 2026 is a Thursday (lead 3), October has 31 days", () => {
    const v = monthView("2026-10-22", 0);
    assert.equal(v.first, "2026-10-01");
    assert.equal(v.lead, 3);
    assert.equal(v.days.length, 31);
    assert.equal(weekdayMon0("2026-10-26"), 0);
    assert.equal(weekdayMon0("2026-10-25"), 6);
    assert.equal(monthView("2026-10-22", 1).first, "2026-11-01");
    assert.equal(monthView("2026-12-15", 1).first, "2027-01-01");
  });
  test("months with bookable days: 22 Oct + 60 d = 21 Dec -> offset 2", () => assert.equal(maxMonthOffset("2026-10-22"), 2));
  test("slot times are shown in Kyiv whatever the offset in the string", () => {
    assert.equal(kyivTime("2026-10-23T12:00:00+03:00"), "12:00");
    assert.equal(kyivTime("2026-10-23T09:00:00Z"), "12:00");
    assert.equal(kyivTime("2026-11-23T10:00:00Z"), "12:00");
    assert.equal(kyivDay("2026-10-23T22:30:00Z"), "2026-10-24");
  });
  test("parts of the day", () => assert.deepEqual(["09:00", "11:59", "12:00", "16:30", "17:00", "19:30"].map(partOfDay), ["morning", "morning", "day", "day", "evening", "evening"]));
});

describe("API error mapping", () => {
  test("statuses -> UI outcome", () => {
    assert.deepEqual([400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504].map(failFor), ["validation", "unauthorized", "unauthorized", "not-found", "conflict", "validation", "rate-limited", "error", "unavailable", "unavailable", "unavailable"]);
  });
  test("the cancel link is reduced to this site's /book/cancel/{uuid} path", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    assert.equal(cancelPath(`https://beautica.app/book/cancel/${id}`), `/book/cancel/${id}`);
    assert.equal(cancelPath(`https://api.beautica.app/book/cancel/${id}?x=1`), `/book/cancel/${id}`, "origin and query are dropped");
    assert.equal(cancelPath("https://evil.example/phish"), null);
    assert.equal(cancelPath("javascript:alert(1)"), null);
    assert.equal(cancelPath(null), null);
  });
});

describe(".ics", () => {
  const ics = buildIcs({ uid: "u-1", startsAt: "2026-10-23T12:00:00+03:00", minutes: 90, summary: "Запис до Оксани; Коваленко", description: "Послуги: A, B\nрядок", location: "Київ" }, new Date("2026-10-22T10:00:00Z"));
  test("is a valid VCALENDAR with UTC times and the duration applied", () => {
    assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
    assert.match(ics, /\r\nDTSTART:20261023T090000Z\r\n/);
    assert.match(ics, /\r\nDTEND:20261023T103000Z\r\n/);
    assert.match(ics, /\r\nDTSTAMP:20261022T100000Z\r\n/);
    assert.match(ics, /END:VEVENT\r\nEND:VCALENDAR\r\n$/);
  });
  test("text is escaped and long lines are folded (RFC 5545)", () => {
    assert.ok(ics.includes("Оксани\; Коваленко"));
    assert.ok(ics.includes("A\\, B\\nрядок"));
    assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "no line over 75 octets");
  });
});

describe("phone mask", () => {
  test("groups as +380 50 123 45 67 and caps at 9 digits", () => {
    assert.equal(formatPhoneGrouped("501234567"), "+380 50 123 45 67");
    assert.equal(formatPhoneGrouped("+380501234567999"), "+380 50 123 45 67");
    assert.equal(formatPhoneGrouped("0501234567"), "+380 50 123 45 67");
    assert.equal(formatPhoneGrouped("50"), "+380 50");
    assert.equal(formatPhoneGrouped(""), "");
    assert.equal(nationalDigits("+380 (50) 123-45-67"), "501234567");
  });
});
