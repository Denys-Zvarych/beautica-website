// Unit tests of the pure link-page modules (src/lib/booking/*, categoryIcon, policy version). Phase 008.
// Node strips the TypeScript types itself; these modules import nothing from the Astro/Workers runtime.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT } from "./helpers/env.mjs";
import { isValidSlug } from "../src/lib/booking/slug.ts";
import { parseMasterInfo, parseSalonInfo, parseReviewsPage, safeImageUrl } from "../src/lib/booking/types.ts";
import { groupByCategory, parseSort, streetLine, formatPriceFrom, formatDuration, pluralServices, pluralReviews, formatRating, fitTitle, fitDescription, relativeUk } from "../src/lib/booking/format.ts";
import { upstreamTtl } from "../src/lib/booking/cache.ts";
import { categoryIconUrl } from "../src/lib/categoryIcon.ts";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";
import { SVC } from "./helpers/mock-api.mjs";

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
