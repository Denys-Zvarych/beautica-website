// Phase 007 QA: src/scripts/track.ts in plain Node (no server, no browser): the event/prop allow-list, the queue and the click listener.
// The module touches `document` / `window` at load, so tiny stand-ins are installed first; every scenario imports a fresh copy (?n=) because
// the queue and the link context are module state.
import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";

let n = 0;
let listeners;
let metaPresent;
let sentTo; // calls of window.umami.track

function fakeDom({ umami = true, marker = true } = {}) {
  listeners = {};
  metaPresent = marker;
  sentTo = [];
  globalThis.window = umami ? { umami: { track: (e, p) => sentTo.push([e, p]) } } : {};
  globalThis.document = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    querySelector: (sel) => (sel === "meta[name=beautica-analytics]" && metaPresent ? {} : null),
  };
}
const load = () => import(`../src/scripts/track.ts?n=${++n}`);
const umamiEvent = (ok) => listeners["beautica:umami"]({ detail: ok });
beforeEach(() => mock.timers.reset());

describe("track(): event and prop allow-list (README § 10)", () => {
  test("an unknown event name sends nothing", async () => {
    fakeDom();
    const { track } = await load();
    for (const e of ["", "page_view", "purchase", "STORE_CLICK", "link_open ", "Link_open"]) track(e, { a: 1 });
    assert.deepEqual(sentTo, []);
  });

  test("props outside the event's allow-list are stripped; allowed ones pass", async () => {
    fakeDom();
    const { track } = await load();
    track("store_click", { store: "google_play", placement: "hero", phone: "+380671234567", name: "Олена", token: TOKEN, email: "a@b.ua" });
    track("service_selected", { count: 2, slug: "x", bookingId: "b1" });
    track("booking_error", { code: 409, message: "Олена, +380671234567" });
    assert.deepEqual(sentTo, [
      ["store_click", { store: "google_play", placement: "hero" }],
      ["service_selected", { count: 2 }],
      ["booking_error", { code: 409 }],
    ]);
  });

  test("an event without props sends `undefined`, and a prop another event owns is not borrowed", async () => {
    fakeDom();
    const { track } = await load();
    track("otp_requested", { phone: "+380671234567", count: 1 });
    track("otp_verified");
    track("link_open", { count: 3 });
    assert.deepEqual(sentTo, [["otp_requested", undefined], ["otp_verified", undefined], ["link_open", undefined]]);
  });

  test("the link context (kind + source) is merged into every event, and a caller's own kind / source are not honoured", async () => {
    fakeDom();
    const { track, setLinkContext } = await load();
    setLinkContext({ kind: "salon", source: "share" });
    track("otp_requested");
    track("slot_selected", { days_ahead: 3, source: "evil", kind: "evil" });
    assert.deepEqual(sentTo, [["otp_requested", { kind: "salon", source: "share" }], ["slot_selected", { days_ahead: 3, kind: "salon", source: "share" }]]);
  });

  test("EVENTS is exactly the README § 10 table (a new event or prop is a deliberate change here too)", async () => {
    fakeDom();
    const { EVENTS } = await load();
    assert.deepEqual(EVENTS, {
      store_click: ["store", "placement"], link_open: ["referrer_host"], profile_view: ["slug"], service_selected: ["count"], slot_selected: ["days_ahead"],
      otp_requested: [], otp_verified: [], otp_failed: [], booking_confirmed: ["services_count"], booking_error: ["code"], install_prompt_click: [],
    });
    for (const props of Object.values(EVENTS)) assert.equal(props.some((p) => /phone|name|token|email|booking_?id|comment/i.test(p)), false);
  });

  // KNOWN GAP (reported to website-dev): EVENTS is a plain object, so an inherited name passes the lookup and `for (const k of allowed)` throws.
  test("an inherited Object.prototype name (constructor, toString, __proto__) is dropped like any unknown event", async () => {
    fakeDom();
    const { track } = await load();
    for (const e of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.doesNotThrow(() => track(e, { a: 1 }), e);
    assert.deepEqual(sentTo, []);
  });

  // KNOWN GAP (reported to website-dev): track() forwards string values as they are; only initClickEvents() and referrerHost() slice to 60. Today's callers
  // pass numbers, codes, a server-rendered slug and the capped referrer host, so nothing leaks; the cap belongs in track() as the last line of defence.
  test("a string value is capped at 60 characters by track() itself", async () => {
    fakeDom();
    const { track } = await load();
    track("profile_view", { slug: "x".repeat(200) });
    assert.equal(sentTo[0][1].slug.length, 60);
  });
});

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

describe("track(): every call site in src/ passes only counts, codes, the slug and the referrer host", () => {
  const files = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|astro)$/.test(e.name) ? [join(dir, e.name)] : []));
  const calls = files("src").flatMap((f) => [...readFileSync(join(ROOT, f), "utf8").matchAll(/\btrack\("(\w+)"(?:, (\{[^\n]*\}))?\)/g)].map((m) => ({ f, event: m[1], arg: m[2] ?? "" })));

  test("the parser finds the known call sites (a broken regex would make this vacuous)", () => assert.ok(calls.length >= 12, `found ${calls.length}`));

  test("each call names an allow-listed event and passes only that event's props, from a non-PII source", async () => {
    fakeDom();
    const { EVENTS } = await load();
    for (const { f, event, arg } of calls) {
      assert.ok(event in EVENTS, `${f}: unknown event ${event}`);
      const keys = [...arg.matchAll(/(\w+):/g)].map((m) => m[1]).filter((k) => !["fail"].includes(k));
      for (const k of keys) assert.ok(EVENTS[event].includes(k), `${f}: ${event} passes ${k}`);
      assert.equal(/\b(phone|name|surname|token|email|comment|bookingId|booking_id|otp|code\b(?!:))/i.test(arg.replace(/\bcode:/, "")), false, `${f}: PII-looking value in ${arg}`);
    }
  });
});

describe("track(): queue until Umami has loaded", () => {
  test("events fired before Umami exists wait and are flushed, in order, when the loader announces success", async () => {
    fakeDom({ umami: false });
    const { track } = await load();
    track("link_open", { referrer_host: "instagram.com" });
    track("profile_view", { slug: "oksana-ab12" });
    assert.deepEqual(sentTo, []);
    globalThis.window.umami = { track: (e, p) => sentTo.push([e, p]) };
    umamiEvent(true);
    assert.deepEqual(sentTo, [["link_open", { referrer_host: "instagram.com" }], ["profile_view", { slug: "oksana-ab12" }]]);
    track("otp_requested"); // settled: sent directly
    assert.equal(sentTo.length, 3);
  });

  test("a failed load drops the queue; nothing is queued afterwards and a later success event replays nothing", async () => {
    fakeDom({ umami: false });
    const { track } = await load();
    track("link_open", { referrer_host: "" });
    globalThis.window.umami = { track: (e, p) => sentTo.push([e, p]) }; // present at the moment of failure: a flush-on-error regression would send
    umamiEvent(false);
    umamiEvent(true);
    assert.deepEqual(sentTo, []);
  });

  test("the queue holds at most 20 events", async () => {
    fakeDom({ umami: false });
    const { track } = await load();
    for (let i = 0; i < 25; i++) track("service_selected", { count: i });
    globalThis.window.umami = { track: (e, p) => sentTo.push([e, p]) };
    umamiEvent(true);
    assert.equal(sentTo.length, 20);
    assert.deepEqual(sentTo[19], ["service_selected", { count: 19 }]);
  });

  test("without the Layout marker (token routes) nothing is queued at all", async () => {
    fakeDom({ umami: false, marker: false });
    const { track } = await load();
    track("link_open", { referrer_host: "" });
    globalThis.window.umami = { track: (e, p) => sentTo.push([e, p]) };
    umamiEvent(true);
    assert.deepEqual(sentTo, []);
  });

  test("when Umami never answers, the queue is dropped after one 20 s cap", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    fakeDom({ umami: false });
    const { track } = await load();
    track("link_open", { referrer_host: "" });
    mock.timers.tick(19_999);
    globalThis.window.umami = { track: (e, p) => sentTo.push([e, p]) };
    mock.timers.tick(1);
    umamiEvent(true);
    assert.deepEqual(sentTo, []);
  });

  test("a throwing Umami never breaks the caller", async () => {
    fakeDom();
    globalThis.window.umami = { track: () => { throw new Error("boom"); } };
    const { track } = await load();
    assert.doesNotThrow(() => track("otp_requested"));
  });
});

describe("initClickEvents(): data-event buttons", () => {
  const click = (target) => listeners.click({ target });
  test("sends a known event with only its props, values cut to 60 characters; unknown event names are ignored", async () => {
    fakeDom();
    const { initClickEvents } = await load();
    initClickEvents();
    initClickEvents(); // idempotent: one listener
    const el = { dataset: { event: "store_click", store: "google_play", placement: "p".repeat(100), phone: "+380671234567" } };
    click({ closest: () => el });
    click({ closest: () => ({ dataset: { event: "purchase", store: "x" } }) });
    click({ closest: () => null });
    assert.deepEqual(sentTo, [["store_click", { store: "google_play", placement: "p".repeat(60) }]]);
  });
});
