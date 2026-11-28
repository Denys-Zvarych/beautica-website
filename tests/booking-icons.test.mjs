// W050: category icon order (iconUrl -> bundled by key/name -> generic) and the icon origin in the booking CSP. Pure modules, no server.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { categoryIconSrc, remoteIconFor } from "../src/lib/categoryIcon.ts";
import { parseCategoryIcons, iconUrls, cachedCategoryIcons, resetIconCache, iconsCacheKey } from "../src/lib/booking/icons.ts";
import { imgOriginsFor } from "../src/lib/mediaOrigin.ts";
import { imageOrigins } from "../src/lib/booking/respond.ts";
import { bookingCsp } from "../src/lib/securityHeaders.ts";

const R2 = "https://media.staging.beautica.test/category-icons/1700-abc.svg";
const api = (rows) => ({ success: true, data: rows });
const icons = parseCategoryIcons(api([
  { name: "NEW_THING", displayName: "Нова послуга", iconUrl: R2 },
  { name: "MANICURE", displayName: "Нігтьовий сервіс", iconUrl: null },
  { name: "BAD", displayName: "Bad", iconUrl: "http://insecure.test/a.svg" },
  { name: "EVIL", displayName: "Evil", iconUrl: "https://x.test/a.svg);background:url(https://evil.test/" },
]));

describe("categoryIconSrc order", () => {
  test("iconUrl wins: by key, then by display name", () => {
    assert.equal(categoryIconSrc("Будь-що", "new_thing", icons), R2);
    assert.equal(categoryIconSrc("Нова послуга", null, icons), R2);
  });
  test("no iconUrl for the category -> bundled by key, then by name", () => {
    assert.equal(categoryIconSrc("Нігтьовий сервіс", "MANICURE", icons), "/icons/category_nail_service.svg");
    assert.equal(categoryIconSrc("Нігтьовий сервіс", null, icons), "/icons/category_nail_service.svg");
  });
  test("unknown everywhere -> generic", () => assert.equal(categoryIconSrc("Щось невідоме", "NOPE", icons), "/icons/category_cosmetology.svg"));
  test("no map (today's API) -> identical to the bundled resolution", () => {
    for (const [n, k] of [["Нігтьовий сервіс", "BODY_MASSAGE"], ["Щось невідоме", null], ["Масаж", undefined]]) {
      assert.equal(categoryIconSrc(n, k, undefined), categoryIconSrc(n, k, {}));
      assert.equal(remoteIconFor(n, k, undefined), null);
    }
  });
  test("prototype keys never resolve", () => assert.equal(remoteIconFor("constructor", "__proto__", icons), null));
});

describe("parseCategoryIcons", () => {
  test("only https URLs that are safe in an unquoted css url()", () => assert.deepEqual(Object.values(icons), [R2, R2]));
  test("a payload without iconUrl or with a bad shape gives an empty / null result", () => {
    assert.deepEqual({ ...parseCategoryIcons(api([{ name: "A", displayName: "B" }])) }, {});
    assert.equal(parseCategoryIcons({ data: "x" }), null);
    assert.equal(parseCategoryIcons(null), null);
  });
});

describe("CSP", () => {
  test("img-src carries the icon origin, nothing else added", () => {
    const origins = imageOrigins([null, ...iconUrls(icons)]);
    assert.deepEqual(origins, ["https://media.staging.beautica.test"]);
    const csp = bookingCsp({ apiOrigin: "https://api.beautica.test", imgOrigins: origins, turnstile: false });
    assert.ok(csp.includes("img-src 'self' data: https://media.staging.beautica.test;"), csp);
  });
  test("no icons -> img-src unchanged", () => {
    const csp = bookingCsp({ apiOrigin: "https://api.beautica.test", imgOrigins: imageOrigins(iconUrls({})), turnstile: false });
    assert.ok(csp.includes("img-src 'self' data:;"), csp);
  });
});

describe("pinned icon origins", () => {
  test("parseCategoryIcons keeps only the pinned media origin; evil.example never survives", () => {
    const raw = api([
      { name: "A", displayName: "A", iconUrl: "https://media.beautica.test/c/a.svg" },
      { name: "E", displayName: "E", iconUrl: "https://evil.example/c/e.svg" },
    ]);
    assert.deepEqual({ ...parseCategoryIcons(raw, ["https://media.beautica.test"]) }, { a: "https://media.beautica.test/c/a.svg" });
    assert.deepEqual({ ...parseCategoryIcons(raw, []) }, {});
  });
  test("an evil iconUrl never reaches the CSP (imageOrigins pinned)", () => {
    const pinned = parseCategoryIcons(api([{ name: "E", displayName: "E", iconUrl: "https://evil.example/e.svg" }]), ["https://media.beautica.test"]);
    const csp = bookingCsp({ apiOrigin: "https://api.beautica.test", imgOrigins: imageOrigins(iconUrls(pinned), ["https://media.beautica.test"]), turnstile: false });
    assert.ok(!csp.includes("evil.example"), csp);
    assert.deepEqual(imageOrigins(["https://evil.example/x.jpg", "https://media.beautica.test/x.jpg"], ["https://media.beautica.test"]), ["https://media.beautica.test"]);
  });
  test("imgOriginsFor: loopback API origin only when the API itself is loopback", () => {
    assert.deepEqual(imgOriginsFor({ apiOrigin: "https://api.beautica.app", mediaOrigin: "https://media.beautica.app" }), ["https://media.beautica.app"]);
    assert.deepEqual(imgOriginsFor({ apiOrigin: "http://127.0.0.1:8787", mediaOrigin: "https://media.beautica.app" }), ["https://media.beautica.app", "http://127.0.0.1:8787"]);
  });
});

describe("icon lookup: stale-while-revalidate, never on the render path", () => {
  const SELF = "https://beautica.app";
  const fakeCache = () => {
    const m = new Map();
    return { m, match: async (k) => m.get(k.url)?.clone(), put: async (k, v) => void m.set(k.url, v) };
  };
  const settle = (ps) => Promise.all(ps);
  const run = async (origin, load, o = {}) => {
    const bg = [];
    const out = await cachedCategoryIcons(origin, load, { self: SELF, waitUntil: (p) => bg.push(p), ...o });
    return { out, bg };
  };
  test("cold miss renders {} without awaiting the icons call; the refresh goes to waitUntil", async () => {
    resetIconCache();
    const t0 = Date.now();
    let started = false;
    const { out, bg } = await run("https://slow.test", () => ((started = true), new Promise(() => {})), { cache: fakeCache(), timeoutMs: 400 });
    assert.deepEqual({ ...out }, {});
    assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
    assert.ok(started);
    assert.equal(bg.length, 1);
    await settle(bg); // the cap ends the hung background fetch
  });
  test("the background fill is served to the next render; the next-next makes no icon request", async () => {
    resetIconCache();
    let calls = 0;
    const load = async () => (calls++, icons);
    const first = await run("https://api.test", load, { cache: fakeCache() });
    assert.deepEqual({ ...first.out }, {});
    await settle(first.bg);
    assert.deepEqual((await run("https://api.test", load, { cache: fakeCache() })).out, icons);
    assert.equal(calls, 1);
  });
  test("the background fill tolerates a 1.5 s backend (default cap ~3 s) and the render is not delayed", async () => {
    resetIconCache();
    const t0 = Date.now();
    const load = (ms) => new Promise((res) => setTimeout(() => res(ms >= 3000 ? icons : null), 1500));
    const first = await run("https://cold.test", load, { cache: fakeCache() });
    assert.ok(Date.now() - t0 < 200);
    assert.deepEqual({ ...first.out }, {});
    await settle(first.bg);
    assert.deepEqual((await run("https://cold.test", load, { cache: fakeCache() })).out, icons);
  });
  test("a timed-out/failed fill is retried after a short window (<= 10 s), not 30 s", async () => {
    resetIconCache();
    let t = 0, calls = 0;
    const load = async () => (calls++, null);
    const o = { cache: null, now: () => t };
    await settle((await run("https://flaky.test", load, o)).bg);
    t = 5_000;
    assert.equal((await run("https://flaky.test", load, o)).bg.length, 0);
    t = 10_000;
    await settle((await run("https://flaky.test", load, o)).bg);
    assert.equal(calls, 2);
  });
  test("a failed lookup is remembered briefly: no second background fetch inside the window", async () => {
    resetIconCache();
    let calls = 0;
    const load = async () => (calls++, null);
    const a = await run("https://down.test", load, { cache: fakeCache() });
    await settle(a.bg);
    const b = await run("https://down.test", load, { cache: fakeCache() });
    assert.equal(b.bg.length, 0);
    assert.equal(calls, 1);
  });
  test("a thrown load = {} and never rejects the waitUntil promise", async () => {
    resetIconCache();
    const r = await run("https://boom.test", async () => { throw new Error("x"); }, { cache: fakeCache() });
    assert.deepEqual({ ...r.out }, {});
    await settle(r.bg);
  });
  test("stale memo is served at once while a refresh runs", async () => {
    resetIconCache();
    let t = 0, calls = 0;
    const load = async () => (calls++, icons);
    const o = { cache: null, now: () => t };
    await settle((await run("https://a.test", load, o)).bg);
    t = 301_000;
    const r = await run("https://a.test", load, o);
    assert.deepEqual(r.out, icons);
    assert.equal(r.bg.length, 1);
    await settle(r.bg);
    assert.equal(calls, 2);
  });
  test("a fresh isolate (empty memo) is served from the Cache API: no icon request", async () => {
    resetIconCache();
    let calls = 0;
    const load = async () => (calls++, icons);
    const cache = fakeCache();
    await settle((await run("https://api2.test", load, { cache })).bg);
    resetIconCache();
    const r = await run("https://api2.test", load, { cache });
    assert.deepEqual({ ...r.out }, { ...icons });
    assert.equal(r.bg.length, 0);
    assert.equal(calls, 1);
  });
  test("the Cache API key is synthetic on OUR host, never the real API URL", async () => {
    resetIconCache();
    const cache = fakeCache();
    const puts = [];
    const spy = { match: cache.match, put: async (k, v) => (puts.push(k.url), cache.put(k, v)) };
    await settle((await run("https://api.beautica.app", async () => icons, { cache: spy })).bg);
    assert.equal(puts.length, 1);
    assert.ok(puts[0].startsWith(`${SELF}/__cache/category-icons?o=`), puts[0]);
    assert.ok(!puts[0].includes("api.beautica.app"));
    assert.notEqual(iconsCacheKey(SELF, "https://a.test").url, iconsCacheKey(SELF, "https://b.test").url);
  });
  test("no own origin -> no edge cache at all (never a guessed key)", async () => {
    resetIconCache();
    const cache = fakeCache();
    await settle((await run("https://api3.test", async () => icons, { cache, self: undefined })).bg);
    assert.equal(cache.m.size, 0);
  });
  test("a cache entry is re-validated on read: evil / unsafe urls and a changed pin are dropped", async () => {
    resetIconCache();
    const cache = fakeCache();
    const bad = { a: R2, e: "https://evil.example/e.svg", u: "https://media.staging.beautica.test/a.svg);x", h: "http://media.staging.beautica.test/a.svg" };
    await cache.put(iconsCacheKey(SELF, "https://api4.test"), new Response(JSON.stringify(bad)));
    const r = await run("https://api4.test", async () => icons, { cache, allowed: ["https://media.staging.beautica.test"] });
    assert.deepEqual({ ...r.out }, { a: R2 });
    resetIconCache();
    const r2 = await run("https://api4.test", async () => icons, { cache, allowed: ["https://other.test"] });
    assert.deepEqual({ ...r2.out }, {}); // everything dropped = a miss-equivalent: bundled icons, refresh scheduled
    assert.equal(r2.bg.length, 1);
  });
});
