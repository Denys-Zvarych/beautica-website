// Unit tests of the pure link-page modules (src/lib/booking/*, categoryIcon, policy version). Phase 008.
// Node strips the TypeScript types itself; these modules import nothing from the Astro/Workers runtime.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROOT } from "./helpers/env.mjs";
import { isValidSlug } from "../src/lib/booking/slug.ts";
import { parseMasterInfo, parseSalonInfo, parseReviewsPage, safeImageUrl, imageOrigin } from "../src/lib/booking/types.ts";
import { groupByCategory, parseSort, streetLine, formatPriceFrom, formatDuration, pluralServices, pluralReviews, formatRating, fitTitle, fitDescription, relativeUk } from "../src/lib/booking/format.ts";
import { upstreamTtl } from "../src/lib/booking/cache.ts";
import { categoryIconUrl, categoryIconFor, KNOWN_KEYS, CATEGORY_ICON_TARGETS } from "../src/lib/categoryIcon.ts";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";
import { SVC } from "./helpers/mock-api.mjs";
import { siblingPath, mobileGate } from "./helpers/backend.mjs";

const nb = " ";

describe("slug validator (same rule as the backend)", () => {
  for (const ok of ["oksana-ab12", "ab", "a-b", "0aa0", "a".repeat(60)]) test(`accepts ${ok.slice(0, 20)}`, () => assert.equal(isValidSlug(ok), true));
  for (const bad of ["", "a", "-ab", "ab-", "Oksana", "ok sana", "ok_sana", "oksana/ab", "../etc", "ок-сана", "a".repeat(61), undefined, 5]) test(`rejects ${JSON.stringify(bad)?.slice(0, 20)}`, () => assert.equal(isValidSlug(bad), false));
});

describe("API parsing is defensive", () => {
  test("only https image URLs survive", () => {
    assert.equal(safeImageUrl("https://m.example/a.jpg"), "https://m.example/a.jpg");
    for (const bad of ["http://m.example/a.jpg", "javascript:alert(1)", "data:image/png;base64,AA", "//m.example/a.jpg", "", null, 5]) assert.equal(safeImageUrl(bad), null, String(bad));
  });
  test("master: nulls, bad items and a http avatar are dropped; rating stays null without reviews", () => {
    const m = parseMasterInfo("x-1", { masterName: "A", masterId: "id", avatarUrl: "http://x/a.jpg", services: [{ id: "s", name: "N", durationMinutes: 30, priceFrom: 100 }, { id: "bad" }, null], avgRating: null, reviewCount: 0, bookable: true, portfolio: [{ url: "https://m/x.jpg" }, { url: "ftp://m/y" }], latestReviews: [{ id: "r", rating: 9, clientDisplayName: "B", comment: null }] });
    assert.equal(m.avatarUrl, null);
    assert.equal(m.services.length, 1);
    assert.deepEqual(m.portfolio, ["https://m/x.jpg"]);
    assert.equal(m.avgRating, null);
    assert.equal(m.latestReviews[0].rating, 5, "rating is clamped to 0..5");
    assert.equal(m.bookable, true);
  });
  test("a response without a name or id is rejected", () => {
    assert.equal(parseMasterInfo("x-1", { masterName: "A" }), null);
    assert.equal(parseMasterInfo("x-1", "nope"), null);
    assert.equal(parseSalonInfo("x-1", { name: "S" }), null);
  });
  test("free-text address fields are capped (locationNote 1000 = backend @Size, street/city 200), control chars stripped", () => {
    const s = parseSalonInfo("s-1", { name: "S", salonId: "1", locationNote: "x".repeat(5000), street: "y".repeat(5000), city: " Київ\u0000 " });
    assert.equal(s.locationNote.length, 1000);
    assert.equal(s.street.length, 200);
    assert.equal(s.city, "Київ");
    const m = parseMasterInfo("m-1", { masterName: "M", masterId: "1", locationNote: "x".repeat(5000), buildingNo: "z".repeat(900) });
    assert.equal(m.locationNote.length, 1000);
    assert.equal(m.buildingNo.length, 200);
  });
  test("imageOrigin: origin of the first usable URL, undefined when none", () => {
    assert.equal(imageOrigin(null, "https://pub-1.r2.dev/a/b.jpg?x=1"), "https://pub-1.r2.dev");
    assert.equal(imageOrigin(null, undefined), undefined);
    assert.equal(imageOrigin("http://x"), undefined);
  });
  test("salon masters: a slug is kept when there is one, a master without one is kept with masterSlug null (backend 391), one without an id cannot be booked and is dropped", () => {
    const s = parseSalonInfo("s-1", {
      salonId: "id",
      name: "S",
      bookable: true,
      masters: [
        { masterSlug: "m-1abc", masterId: "id-1", name: "With link" },
        { masterSlug: null, masterId: "id-2", name: "No link" },
        { masterSlug: "  ", masterId: "id-3", name: "Blank link" },
        { masterSlug: "m-4abc", name: "No id" },
        { masterId: "id-5" },
      ],
    });
    assert.deepEqual(s.masters.map((x) => [x.masterId, x.masterSlug]), [["id-1", "m-1abc"], ["id-2", null], ["id-3", null]]);
    assert.deepEqual(s.masters.filter((x) => x.masterSlug === null).map((x) => x.name), ["No link", "Blank link"], "no own card link for them");
  });
  test("bookable is false unless exactly true", () => assert.equal(parseMasterInfo("x-1", { masterName: "A", masterId: "i", bookable: "true" }).bookable, false));
});

describe("formatting", () => {
  test("price is always «від N ₴» (the API has no price type)", () => {
    assert.equal(formatPriceFrom(450), `від${nb}450${nb}₴`);
    assert.equal(formatPriceFrom(1250), `від${nb}1${nb}250${nb}₴`);
  });
  test("durations", () => {
    assert.equal(formatDuration(30), `30${nb}хв`);
    assert.equal(formatDuration(60), `1${nb}год`);
    assert.equal(formatDuration(90), `1${nb}год${nb}30${nb}хв`);
  });
  test("Ukrainian plurals", () => {
    assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25].map(pluralServices), ["1 послуга", "2 послуги", "5 послуг", "11 послуг", "12 послуг", "21 послуга", "22 послуги", "25 послуг"]);
    assert.deepEqual([0, 1, 3, 12, 128].map(pluralReviews), ["0 відгуків", "1 відгук", "3 відгуки", "12 відгуків", "128 відгуків"]);
  });
  test("rating", () => {
    assert.equal(formatRating(4.86), "4.9");
    assert.equal(formatRating(5), "5.0");
    assert.equal(formatRating(null), "—");
  });
  test("title fits 60 chars, never cut mid-word; description fits 155", () => {
    assert.equal(fitTitle(60, "x".repeat(70), "Оксана — Майстер"), "Оксана — Майстер");
    const long = "Дуже довге ім'я майстра з дуже довгою посадою і ще довшим описом посади";
    const t = fitTitle(60, long);
    assert.ok(t.length <= 60 && t.endsWith("…"));
    assert.ok(fitDescription("слово ".repeat(60), 155).length <= 155);
    assert.equal(fitDescription("short", 155), "short");
  });
  test("relative time is coarse and Ukrainian", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    assert.equal(relativeUk("2026-10-19T12:00:00Z", now), `3${nb}дні тому`);
    assert.equal(relativeUk("2026-10-15T12:00:00Z", now), "тиждень тому");
    assert.equal(relativeUk("2026-10-22T11:59:00Z", now), "щойно");
    assert.equal(relativeUk("garbage", now), "");
  });
});

describe("edge-cache TTL", () => {
  test("follows the upstream s-maxage, default 30 s", () => {
    assert.equal(upstreamTtl("public, max-age=0, s-maxage=30"), 30);
    assert.equal(upstreamTtl("public, s-maxage=600"), 600);
    assert.equal(upstreamTtl(null), 30);
    assert.equal(upstreamTtl("no-store"), 30);
    assert.equal(upstreamTtl("s-maxage=0"), 1);
  });
});

describe("category icons (port of the app's keyword stage)", () => {
  test("known names, fallback", () => {
    assert.equal(categoryIconUrl("Нігтьовий сервіс"), "/icons/category_nail_service.svg", "live platform name (exact stage)");
    assert.equal(categoryIconUrl("Перукарські послуги"), "/icons/category_hairdressing.svg");
    assert.equal(categoryIconUrl("Подологія"), "/icons/category_podology.svg");
    assert.equal(categoryIconUrl("Щось невідоме"), "/icons/category_cosmetology.svg", "unknown = cosmetology fallback like the app");
    assert.equal(categoryIconUrl("Манікюр"), "/icons/category_nail_service.svg");
    assert.equal(categoryIconUrl("Ламінування вій"), "/icons/category_lash_lamination.svg");
    assert.equal(categoryIconUrl("Брови"), "/icons/category_brows.svg");
    assert.equal(categoryIconUrl("Стрижка"), "/icons/category_hairdressing.svg");
  });
});

describe("body massage category icon (phase 035)", () => {
  const MASSAGE = "/icons/category_body_massage.svg";
  const FALLBACK = "/icons/category_cosmetology.svg";
  test("exact platform name resolves to the massage icon", () => assert.equal(categoryIconUrl("Масаж і догляд за тілом"), MASSAGE));
  test("exact name is trimmed and case-insensitive", () => assert.equal(categoryIconUrl("  МАСАЖ І ДОГЛЯД ЗА ТІЛОМ "), MASSAGE));
  test("the BODY_MASSAGE key wins, any name", () => {
    assert.equal(categoryIconFor("Масаж і догляд за тілом", "BODY_MASSAGE"), MASSAGE);
    assert.equal(categoryIconFor("Щось інше", "BODY_MASSAGE"), MASSAGE);
  });
  test("the key is case-insensitive: lowercase body_massage wins, any name", () => {
    assert.equal(categoryIconFor("Щось інше", "body_massage"), MASSAGE);
    assert.equal(categoryIconFor("Щось інше", "Body_Massage"), MASSAGE);
  });
  test("an unknown key with a massage name maps via the name rule; with a non-massage name, the fallback", () => {
    assert.equal(categoryIconFor("Масаж і догляд за тілом", "NOPE"), MASSAGE);
    assert.equal(categoryIconFor("Антицелюлітний масаж", "NOPE"), MASSAGE);
    assert.equal(categoryIconFor("Класичний масаж", ""), MASSAGE);
    assert.equal(categoryIconFor("Щось невідоме", "NOPE"), FALLBACK);
  });
  test("keyword stage: a name with only «масаж» maps to massage", () => {
    assert.equal(categoryIconUrl("Класичний масаж"), MASSAGE);
    assert.equal(categoryIconFor("Антицелюлітний масаж"), MASSAGE);
  });
  test("a more specific rule beats the massage keyword", () => {
    assert.equal(categoryIconUrl("Масаж обличчя косметологія"), "/icons/category_cosmetology.svg");
    assert.equal(categoryIconUrl("Масаж волосся"), "/icons/category_hairdressing.svg");
    assert.equal(categoryIconUrl("Масаж і депіляція"), "/icons/category_hair_removal.svg");
  });
  test("unknown name and unknown key fall back to cosmetology", () => {
    assert.equal(categoryIconUrl("Щось невідоме"), FALLBACK);
    assert.equal(categoryIconFor("Щось невідоме", "NOPE"), FALLBACK);
    assert.equal(categoryIconFor("Щось невідоме", null), FALLBACK);
  });
  test("prototype keys are not categories (own-property lookup)", () => {
    for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) assert.equal(categoryIconUrl(n), FALLBACK, n);
    assert.equal(categoryIconFor("constructor", "constructor"), FALLBACK);
  });
});

describe("category icon files", () => {
  const FALLBACK = categoryIconUrl("Щось невідоме");
  const dir = join(ROOT, "public", "icons");
  const files = readdirSync(dir).filter((f) => /^category_.+\.svg$/.test(f)).sort();
  const targets = CATEGORY_ICON_TARGETS.map((t) => `category_${t}.svg`).sort();
  /** sha256 of public/icons/category_body_massage.svg = the app's assets/icons/category_body_massage.svg. Change it only together with the app's file. */
  const MASSAGE_SHA256 = "7a222e0baa1c38d7d0833a5ed9ab50a932d501caf4c6665885ebcb498c371b18";
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");

  test("category_*.svg file names equal the icon keys categoryIcon.ts can emit (no orphan, no missing file)", () => {
    assert.deepEqual(files, targets);
  });
  test("every key the category-key stage knows is an emittable icon, and the fallback glyph is one of them", () => {
    for (const k of KNOWN_KEYS) assert.ok(CATEGORY_ICON_TARGETS.includes(k), k);
    assert.ok(CATEGORY_ICON_TARGETS.includes(FALLBACK.match(/category_(.+)\.svg/)[1]));
  });
  test("the claims ledger count («N category icons») equals the number of icon keys", () => {
    const row = readFileSync(join(ROOT, "docs", "claims.md"), "utf8").split("\n").find((l) => /^\| \d+ category icons/.test(l));
    assert.ok(row, "claims row «N category icons» is gone");
    assert.equal(Number(/^\| (\d+) /.exec(row)[1]), CATEGORY_ICON_TARGETS.length);
  });
  test("category_body_massage.svg is pinned to the app's bytes (sha256; always runs, also without the sibling repo)", () => {
    assert.equal(sha(readFileSync(join(dir, "category_body_massage.svg"))), MASSAGE_SHA256);
  });
  test("category_body_massage.svg is byte-identical to the sibling app's file (extra check, runs when ../beautica-mobile is present)", (t) => {
    const app = siblingPath("../beautica-mobile/assets/icons/category_body_massage.svg");
    if (!mobileGate(app)) return t.skip("sibling repo absent: the sha256 pin above is the guard");
    assert.equal(sha(readFileSync(app)), sha(readFileSync(join(dir, "category_body_massage.svg"))));
    assert.equal(sha(readFileSync(app)), MASSAGE_SHA256, "the app's file changed: update MASSAGE_SHA256 together with public/icons");
  });
  test("the app's category_icons.dart still maps «масаж» to the body massage icon (the line the claims row points at)", (t) => {
    const row = readFileSync(join(ROOT, "docs", "claims.md"), "utf8").split("\n").find((l) => l.includes("category_icons.dart:"));
    assert.ok(row, "claims row for category_icons.dart is gone");
    const [, rel, line] = /`(\.\.\/beautica-mobile\/[^:`]+):(\d+)`/.exec(row);
    const file = siblingPath(rel);
    if (!mobileGate(file)) return t.skip("sibling repo absent");
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.slice(Number(line) - 1, Number(line) + 1).join(" ");
    assert.ok(at.includes("'масаж'") && at.includes("categoryBodyMassage"), `claims row line ${line} no longer holds the massage rule: ${at}`);
  });

  describe("every category icon is a safe, well-formed SVG", () => {
    /** Strict-enough well-formedness: one <svg> root, balanced tags, quoted attributes, no stray < or &. */
    function wellFormed(xml) {
      const body = xml.replace(/^\s*<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").trim();
      const stack = [];
      let pos = 0, roots = 0;
      for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g)) {
        if (/[<&](?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(body.slice(pos, m.index).replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, ""))) return "stray < or & in text";
        pos = m.index + m[0].length;
        if (m[1]) { if (stack.pop() !== m[2]) return `unbalanced </${m[2]}>`; }
        else { if (!stack.length) roots++; if (!m[4]) stack.push(m[2]); }
      }
      if (body.slice(pos).trim()) return "trailing content";
      if (/<(?!\/?[A-Za-z])/.test(body)) return "malformed tag";
      if (stack.length) return `unclosed <${stack.at(-1)}>`;
      return roots === 1 && /^<svg[\s>]/.test(body) ? null : "exactly one <svg> root expected";
    }
    for (const f of files) {
      test(f, () => {
        const buf = readFileSync(join(dir, f));
        const xml = buf.toString("utf8");
        assert.equal(wellFormed(xml), null, "well-formed XML");
        assert.match(xml, /<svg\b[^>]*\sviewBox="[^"]+"/, "has a viewBox");
        assert.match(xml, /<svg\b[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.doesNotMatch(xml, /<\s*(script|foreignObject|iframe|object|embed|style)\b/i, "no script / foreignObject / active content");
        assert.doesNotMatch(xml, /\son[a-z]+\s*=/i, "no on* attributes");
        assert.doesNotMatch(xml, /\b(?:xlink:)?href\s*=\s*["'](?!#)/i, "no external href (fragment refs only)");
        assert.doesNotMatch(xml, /url\(\s*["']?(?!#)/i, "no external url()");
        assert.ok(buf.length <= 16 * 1024, `${buf.length} bytes > 16 KB`);
      });
    }
    test("the checker itself rejects bad input (script, unbalanced, on*, external href)", () => {
      assert.equal(wellFormed('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'), null);
      assert.ok(wellFormed('<svg viewBox="0 0 1 1"><g></svg>'));
      assert.ok(wellFormed('<svg viewBox="0 0 1 1"><path d="M0 0"></svg>'));
      assert.ok(wellFormed('<svg viewBox="0 0 1 1"></svg><svg></svg>'));
    });
  });
});

describe("policy version", () => {
  test("equals the published privacy page date and matches the backend format", () => {
    const md = readFileSync(`${ROOT}/src/content/legal/uk/privacy.md`, "utf8");
    assert.equal(md.match(/^updated: (\S+)/m)[1], PRIVACY_POLICY_VERSION);
    assert.match(PRIVACY_POLICY_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d{1,3})?$/);
  });
});

describe("mock backend sanity", () => {
  test("fixture services have unique ids", () => assert.equal(new Set(SVC.map((s) => s.id)).size, SVC.length));
});

describe("parity data (backend 383-385)", () => {
  test("rating distribution is always five rows 5 -> 1, zero-filled, whatever the API sent", () => {
    const m = parseMasterInfo("x-1", { masterName: "A", masterId: "i", ratingDistribution: [{ rating: 3, count: 4 }, { rating: 9, count: 1 }, { rating: 5, count: "2" }] });
    assert.deepEqual(m.ratingDistribution, [{ rating: 5, count: 2 }, { rating: 4, count: 0 }, { rating: 3, count: 4 }, { rating: 2, count: 0 }, { rating: 1, count: 0 }]);
    assert.equal(parseMasterInfo("x-1", { masterName: "A", masterId: "i" }).ratingDistribution.length, 5);
  });
  test("services group by category key in the API's category order; unknown go last; empty groups vanish", () => {
    const cats = [{ name: "Нігті", key: "NAIL" }, { name: "Брови", key: "BROWS" }, { name: "Порожня", key: "X" }];
    const g = groupByCategory([{ n: 1, category: "BROWS" }, { n: 2, category: "NAIL" }, { n: 3, category: "NAIL" }, { n: 4, category: null }, { n: 5, category: "ZZZ" }], cats, "Інше");
    assert.deepEqual(g.map((x) => [x.name, x.items.map((i) => i.n)]), [["Нігті", [2, 3]], ["Брови", [1]], ["Інше", [4, 5]]]);
  });
  test("address fields and the master's service category are parsed; salon extras too", () => {
    const m = parseMasterInfo("x-1", { masterName: "A", masterId: "i", street: "вул. А", buildingNo: "5", locationNote: "поверх 2", services: [{ id: "s", name: "N", durationMinutes: 30, priceFrom: 1, category: "NAIL" }], categories: [{ id: "c", name: "Нігті", key: "NAIL" }] });
    assert.deepEqual([m.street, m.buildingNo, m.locationNote, m.services[0].category, m.categories[0].key], ["вул. А", "5", "поверх 2", "NAIL", "NAIL"]);
    const s = parseSalonInfo("s-1", { salonId: "i", name: "S", description: "d", locationNote: "n", portfolio: [{ url: "https://m/1.jpg" }, { url: "http://x" }], serviceCategories: [{ category: "BROWS", displayName: "Брови", count: 2, services: [{ id: "a", name: "A", baseDurationMinutes: 30, priceDisplay: "250 ₴" }] }, { category: "EMPTY", services: [] }], ratingDistribution: [], latestReviews: [{ id: "r", rating: 4, clientDisplayName: "К.", masterFirstName: "О", masterLastName: "К" }] });
    assert.deepEqual([s.description, s.locationNote, s.portfolio.length, s.serviceCategories.length, s.serviceCategories[0].services[0].priceLabel, s.latestReviews[0].masterName], ["d", "n", 1, 1, "250 ₴", "О К"]);
    assert.equal(s.ratingDistribution.length, 5);
  });
  test("a /reviews page is parsed; anything else is rejected", () => {
    const p = parseReviewsPage({ success: true, data: [{ id: "r", rating: 5, clientDisplayName: "К." }], page: 1, size: 5, totalElements: 12, totalPages: 3 });
    assert.deepEqual([p.items.length, p.page, p.totalPages, p.totalElements], [1, 1, 3, 12]);
    assert.equal(parseReviewsPage({ success: false }), null);
  });
  test("sort parameter: only the four known values, default NEWEST; street line", () => {
    assert.deepEqual(["OLDEST", "HIGHEST", "LOWEST", "NEWEST", "x", null, "oldest"].map(parseSort), ["OLDEST", "HIGHEST", "LOWEST", "NEWEST", "NEWEST", "NEWEST", "NEWEST"]);
    assert.equal(streetLine("вул. Хрещатик", "22"), "вул. Хрещатик, 22");
    assert.equal(streetLine("вул. Хрещатик", null), "вул. Хрещатик");
    assert.equal(streetLine(null, "22"), "22");
    assert.equal(streetLine(null, null), null);
  });
});
