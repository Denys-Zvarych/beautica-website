// Unit tests of the booking-flow modules: calendar (Europe/Kyiv), API error mapping, .ics, phone mask. Phase 009.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addDays, inWindow, kyivToday, maxMonthOffset, monthView, partOfDay, weekdayMon0, WINDOW_DAYS, kyivTime, kyivDay } from "../src/scripts/booking/calendar.ts";
import { failFor, cancelPath, cancelToken } from "../src/scripts/booking/api.ts";
import { buildIcs } from "../src/scripts/booking/ics.ts";
import { formatPhoneGrouped, nationalDigits } from "../src/lib/phone.ts";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanName, cleanComment, typingName } from "../src/lib/booking/text.ts";

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
  test("409 BOOKING_UNAVAILABLE (backend 398) is its own outcome; any other 409 body stays a conflict", () => {
    assert.equal(failFor(409, "BOOKING_UNAVAILABLE"), "provider-unavailable");
    for (const code of [undefined, null, "SLOT_TAKEN", "booking_unavailable", {}]) assert.equal(failFor(409, code), "conflict");
    assert.equal(failFor(400, "BOOKING_UNAVAILABLE"), "validation", "only a 409 is mapped by code");
  });
  test("the cancel link is reduced to this site's /book/cancel/{uuid} path", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    assert.equal(cancelPath(`https://beautica.app/book/cancel/${id}`), `/book/cancel/${id}`);
    assert.equal(cancelPath(`https://api.beautica.app/book/cancel/${id}?x=1`), `/book/cancel/${id}`, "origin and query are dropped");
    assert.equal(cancelPath("https://evil.example/phish"), null);
    assert.equal(cancelPath("javascript:alert(1)"), null);
    assert.equal(cancelPath("https://beautica.app/book/cancel/" + "-".repeat(36)), null, "36 dashes is not a UUID");
    assert.equal(cancelPath(null), null);
  });
  test("the short cancel link /c/{16 alphanumerics} is kept (case-sensitive), cancelToken reads both forms", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    assert.equal(cancelPath("https://beautica.app/c/Ab3dEf7hJk9mNp2Q"), "/c/Ab3dEf7hJk9mNp2Q");
    assert.equal(cancelPath("https://beautica.app/c/Ab3dEf7hJk9mNp2Q?x=1"), "/c/Ab3dEf7hJk9mNp2Q");
    for (const bad of ["/c/Ab3dEf7hJk9mNp2", "/c/Ab3dEf7hJk9mNp2QQ", "/c/Ab3dEf7hJk9mNp2-", "/c/Ab3dEf7hJk9mNp2Q/x", "/c/"]) assert.equal(cancelPath(`https://beautica.app${bad}`), null, bad);
    assert.equal(cancelToken("/c/Ab3dEf7hJk9mNp2Q"), "Ab3dEf7hJk9mNp2Q");
    assert.equal(cancelToken(`/book/cancel/${id}`), id);
    assert.equal(cancelToken("/c/short"), null);
    assert.equal(cancelToken(null), null);
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
    assert.ok(ics.includes("Оксани\\; Коваленко"));
    assert.ok(ics.includes("A\\, B\\nрядок"));
    assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "no line over 75 octets");
  });
});

describe(".ics carries no cancel link (phase 025)", () => {
  const URL_ = "https://beautica.app/book/cancel/123e4567-e89b-42d3-a456-426614174000";
  const base = { uid: "u", startsAt: "2026-10-23T12:00:00+03:00", minutes: 30, summary: "S", description: "Послуги: A.", location: "Київ" };
  const now = new Date("2026-10-22T10:00:00Z");
  const unfold = (t) => t.replace(/\r\n /g, "");
  test("a stray url field is ignored: no URL property, no cancel URL anywhere; all lines CRLF, <= 75 octets", () => {
    const ics = buildIcs({ ...base, url: URL_ }, now);
    assert.equal(/^URL:/m.test(unfold(ics)), false);
    assert.equal(unfold(ics).includes("book/cancel"), false);
    assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "no line over 75 octets");
    assert.equal(/[^\r]\n/.test(ics), false, "no bare LF");
    assert.ok(ics.endsWith("\r\n"));
  });
  test("output is identical with or without a url field", () => {
    assert.equal(buildIcs({ ...base, url: URL_ }, now), buildIcs(base, now));
    assert.equal(/^URL:/m.test(buildIcs(base, now)), false);
  });
  test("folding counts octets: 3- and 4-octet characters never push a line past 75 and are not split", () => {
    const d = "₴".repeat(60) + "😀".repeat(30);
    const ics = buildIcs({ ...base, description: d }, now);
    assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
    assert.ok(unfold(ics).includes(`DESCRIPTION:${d}`));
  });
});

describe(".ics control characters cannot inject properties (phase 015 audit)", () => {
  const evil = "x\rURL:https://evil.example\ny\r\nATTENDEE:z\u2028BEGIN:VEVENT\u2029q\u0000\u0007\u001f\u007fend";
  const ics = buildIcs({ uid: "u", startsAt: "2026-10-23T12:00:00+03:00", minutes: 30, summary: evil, description: evil, location: evil }, new Date("2026-10-22T10:00:00Z"));
  test("every TEXT value: no raw CR/LF/control char survives; no unfolded line starts with an injected property", () => {
    const lines = ics.replace(/\r\n /g, "").split("\r\n");
    const allowed = /^(BEGIN:VCALENDAR|VERSION|PRODID|CALSCALE|METHOD|BEGIN:VEVENT|UID|DTSTAMP|DTSTART|DTEND|SUMMARY|DESCRIPTION|LOCATION|BEGIN:VALARM|ACTION|TRIGGER|END:VALARM|END:VEVENT|END:VCALENDAR|)(:|$)/;
    for (const l of lines) assert.ok(allowed.test(l), `unexpected line: ${l}`);
    assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u2028\u2029]/.test(ics.replace(/\r\n/g, "")), false);
    assert.equal(/\n/.test(ics.replace(/\r\n/g, "")), false, "no bare LF");
    assert.equal(/\r(?!\n)/.test(ics), false, "no bare CR");
    assert.ok(unfoldAll(ics).includes("SUMMARY:x\\nURL:https://evil.example\\ny\\nATTENDEE:z\\nBEGIN:VEVENT\\nqend"));
  });
});
function unfoldAll(t) { return t.replace(/\r\n /g, ""); }

describe(".ics never emits a URL property; C1 controls stripped (phase 025)", () => {
  const b = { uid: "u", startsAt: "2026-10-23T12:00:00+03:00", minutes: 30, summary: "S", description: "D", location: "" };
  const now = new Date("2026-10-22T10:00:00Z");
  test("no url value, safe or unsafe, ever produces a URL line", () => {
    for (const u of ["x\r\nATTENDEE:y", "https://a.b/c\r\nATTENDEE:y", "javascript:alert(1)", "https://a b", "x", "http://localhost:3000/book/cancel/x", "https://beautica.app/book/cancel/x"]) {
      const ics = buildIcs({ ...b, url: u }, now);
      assert.equal(/^URL:/m.test(ics), false, u);
      assert.equal(ics.includes("ATTENDEE"), false, u);
    }
  });
  test("C1 control characters are removed from TEXT values", () => {
    const ics = buildIcs({ ...b, summary: "a\u0080b\u009fc\u0090d" }, now);
    assert.ok(ics.includes("SUMMARY:abcd\r\n"));
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

describe(".ics escaping of ; , \\ and line breaks (RFC 5545 section 3.3.11)", () => {
  const ics = buildIcs({ uid: "u", startsAt: "2026-10-23T12:00:00+03:00", minutes: 30, summary: "A;B,C\\D", description: "x;y,z\\w\nline", location: "" }, new Date("2026-10-22T10:00:00Z"));
  test("semicolon, comma and backslash are backslash-escaped, newline becomes \\n", () => {
    assert.ok(ics.includes("SUMMARY:A\\;B\\,C\\\\D"), ics);
    assert.ok(ics.includes("DESCRIPTION:x\\;y\\,z\\\\w\\nline"), ics);
    assert.equal(/SUMMARY:A;B/.test(ics), false, "no bare semicolon");
  });
});

describe("guest text is cleaned to the backend's rules (no control characters in names; comment keeps \\n and \\t)", () => {
  test("names: tabs / control characters become one space, whitespace collapses, trimmed; a name of only controls is empty", () => {
    assert.equal(cleanName("  Мар\tина\u0007  Іванівна\n"), "Мар ина Іванівна");
    assert.equal(cleanName("\t\t \u0000"), "");
    assert.equal(cleanName("Олена"), "Олена");
    assert.equal(/[\u0000-\u001F\u007F]/.test(cleanName("a\u001Fb\u007Fc\td")), false);
  });
  test("while typing: the trailing space survives (a second word can follow), doubles collapse, leading space is dropped", () => {
    assert.equal(typingName("Анна "), "Анна ");
    assert.equal(typingName("Анна   Марія"), "Анна Марія");
    assert.equal(typingName("  Анна"), "Анна");
    assert.equal(typingName("А\tн"), "А н");
  });
  test("comment: line breaks and tabs stay, other control characters go, \\r\\n becomes \\n, trimmed", () => {
    assert.equal(cleanComment("  рядок1\r\nрядок2\tкінець\u0007\u0000  "), "рядок1\nрядок2\tкінець");
    assert.equal(cleanComment("\u000Bx\u000C\u001Fy\u007F"), "xy");
    assert.equal(cleanComment("   "), "");
  });
});

// info.ts / invite.ts use extensionless imports, so bundle them for node.
const bundle = async (entry) => {
  const outfile = join(mkdtempSync(join(tmpdir(), "bt-")), "m.mjs");
  // config.ts reads the Worker env from `cloudflare:workers`: an empty stand-in is enough for the pure normalizers.
  const workersStub = { name: "workers-stub", setup: (b) => (b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "w", namespace: "w" })), b.onLoad({ filter: /.*/, namespace: "w" }, () => ({ contents: "export const env = {};", loader: "js" }))) };
  await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent", plugins: [workersStub] });
  return import(pathToFileURL(outfile).href);
};
const { fetchMasterInfo } = await bundle("../src/lib/booking/info.ts");
const { fetchInvite, parseInvite } = await bundle("../src/lib/review/invite.ts");
const { normalizeMediaOrigin } = await bundle("../src/lib/booking/config.ts");

describe("X-Beautica-Client-IP is sent only together with the Worker key", () => {
  const TOKEN = "a".repeat(43);
  const capture = async (run) => {
    const real = globalThis.fetch;
    let headers;
    globalThis.fetch = async (_u, init) => {
      headers = init.headers;
      return new Response("{}", { status: 404 });
    };
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
    return headers;
  };
  for (const [name, call] of [
    ["info", (cfg) => fetchMasterInfo(cfg, "x-1111", "203.0.113.9")],
    ["invite", (cfg) => fetchInvite(cfg, TOKEN, "203.0.113.9")],
  ]) {
    test(`${name}: no key -> no key and no IP header`, async () => {
      const h = await capture(() => call({ apiOrigin: "http://x.test", workerKey: "" }));
      assert.ok(h, "fetch was called");
      assert.equal(h["X-Beautica-Client-IP"], undefined);
      assert.equal(h["X-Beautica-Worker-Key"], undefined);
    });
    test(`${name}: with key -> both headers`, async () => {
      const h = await capture(() => call({ apiOrigin: "http://x.test", workerKey: "k" }));
      assert.equal(h["X-Beautica-Client-IP"], "203.0.113.9");
      assert.equal(h["X-Beautica-Worker-Key"], "k");
    });
  }
});

describe("review invite hardening (F2-F4)", () => {
  const TOKEN = "a".repeat(43);
  test("X-Beautica-Client-IP: only an IP literal is forwarded (CRLF / junk dropped, IPv6 ok)", async () => {
    const sent = async (ip) => {
      const real = globalThis.fetch;
      let h;
      globalThis.fetch = async (_u, init) => ((h = init.headers), new Response("{}", { status: 404 }));
      try {
        await fetchInvite({ apiOrigin: "http://x.test", workerKey: "k" }, TOKEN, ip);
      } finally {
        globalThis.fetch = real;
      }
      return h["X-Beautica-Client-IP"];
    };
    assert.equal(await sent("1.2.3.4\r\nX: y"), undefined);
    assert.equal(await sent("evil, 1.2.3.4"), undefined);
    assert.equal(await sent("2001:db8::1"), "2001:db8::1");
    assert.equal(await sent("1.2.3.4"), "1.2.3.4");
  });
  const ID = "50000001-1111-4222-8333-944455556666";
  const base = (o = {}) => ({ state: "OPEN", providerName: "P", visitDate: "2026-10-24", displayName: "D", items: [{ bookingId: ID, serviceName: "S", masterName: "M" }], ...o });
  const MEDIA = "https://media.beautica.app";
  test("avatar: media origin only", () => {
    assert.equal(parseInvite(base({ avatarUrl: `${MEDIA}/a.png` }), MEDIA).data.avatarUrl, `${MEDIA}/a.png`);
    assert.equal(parseInvite(base({ avatarUrl: "https://evil.example/a.png" }), MEDIA).data.avatarUrl, null);
    assert.equal(parseInvite(base({ avatarUrl: `${MEDIA}.evil.example/a.png` }), MEDIA).data.avatarUrl, null);
    assert.equal(parseInvite(base({ avatarUrl: `${MEDIA}/a.png` })).data.avatarUrl, null, "no configured origin -> no avatar");
  });
  test("bookingId must be a UUID: bad items dropped, none left -> unparseable", () => {
    const r = parseInvite(base({ items: [{ bookingId: "../x", serviceName: "S" }, { bookingId: ID, serviceName: "S2" }] }), MEDIA);
    assert.deepEqual(r.data.items.map((i) => i.serviceName), ["S2"]);
    assert.equal(parseInvite(base({ items: [{ bookingId: "nope", serviceName: "S" }] }), MEDIA), null);
  });
  test("strings are capped at 200 chars", () => {
    const r = parseInvite(base({ providerName: "x".repeat(5000) }), MEDIA);
    assert.equal(r.data.providerName.length, 200);
  });
});

describe("MEDIA_ORIGIN normalisation (the only origin an avatar may come from)", () => {
  const PROD = "https://media.beautica.app";
  test("https origin kept, path/query dropped", () => {
    assert.equal(normalizeMediaOrigin("https://media.beautica.test/some/path?x=1"), "https://media.beautica.test");
  });
  test("http, junk, blank and non-strings fall back to the prod media host (never to an attacker-chosen origin)", () => {
    for (const bad of ["http://media.beautica.test", "javascript:alert(1)", "not a url", "", "   ", undefined, null, 42]) {
      assert.equal(normalizeMediaOrigin(bad), PROD, String(bad));
    }
  });
});
