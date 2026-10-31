// Phase 022: client logic of the success-screen reminder choice (SMS / Telegram) against backend 407. No server, no browser:
// fetch is stubbed; the wire shape is pinned to the backend's Java records (sibling repo, gated like the other contract specs).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_DIR, backendGate } from "./helpers/backend.mjs";
import { mountReminders, offered, errorFor, firstWithToken, availabilityFromStatus } from "../src/scripts/booking/reminder-channel.ts";
import { cancelToken, cancelPath, readTelegram, telegramLinkToken, telegramStatus, telegramUnlink, TELEGRAM_URL } from "../src/scripts/booking/api.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const API = "https://api.example";
const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));
const stub = (status, body) => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return seen;
};

describe("cancel token", () => {
  test("is taken only from an already-validated cancel path", () => {
    assert.equal(cancelToken(cancelPath(`https://x.example/book/cancel/${UUID}`)), UUID);
    assert.equal(cancelToken(null), null);
    assert.equal(cancelToken("/book/cancel/not-a-uuid"), null);
    assert.equal(cancelToken(`/evil/${UUID}`), null);
  });
});

describe("readTelegram (booking response block)", () => {
  test("absent / malformed = no choice", () => {
    for (const v of [undefined, null, "x", {}, { available: "yes", linked: false }, { available: true }]) assert.equal(readTelegram(v), null);
  });
  test("well-formed", () => {
    assert.deepEqual(readTelegram({ available: true, linked: false }), { available: true, linked: false });
    assert.deepEqual(readTelegram({ available: false, linked: false }), { available: false, linked: false });
  });
});

describe("t.me url guard", () => {
  test("accepts the backend shape", () => assert.ok(TELEGRAM_URL.test("https://t.me/beautica_app_bot?start=Qm9-_x")));
  for (const bad of ["https://t.me@evil.example/beautica_app_bot?start=a", "tg://resolve?domain=beautica_app_bot&start=a", "https://t.me/beautica_app_bot?start=a\n", "https://t.me/beautica_app_bot?start=a#frag", "https://t.me/beautica_app_bot?start=a&x=1", "https://t.me.evil.com/beautica_app_bot?start=a", "HTTPS://T.ME/beautica_app_bot?start=a", " https://t.me/beautica_app_bot?start=a"])
    test(`rejects lookalike ${JSON.stringify(bad)}`, () => assert.equal(TELEGRAM_URL.test(bad), false));
  for (const bad of ["https://evil.example/x?start=a", "http://t.me/beautica_app_bot?start=a", "https://t.me.evil.example/beautica_app_bot?start=a", "https://t.me/ab?start=a", "https://t.me/beautica_app_bot?start=a&x=1", "https://t.me/beautica_app_bot", "javascript:alert(1)", "https://t.me/beautica_app_bot?start=a#"])
    test(`rejects ${bad}`, () => assert.equal(TELEGRAM_URL.test(bad), false));
});

describe("link-token", () => {
  test("POST with {cancelToken} only, no credentials, returns the url", async () => {
    const seen = stub(200, { url: "https://t.me/beautica_app_bot?start=abc", expiresAt: "2026-11-02T10:30:00Z", alreadyLinked: false });
    const r = await telegramLinkToken(API, UUID);
    assert.deepEqual(r, { ok: true, data: { alreadyLinked: false, url: "https://t.me/beautica_app_bot?start=abc" } });
    assert.equal(seen[0].url, `${API}/api/v1/book/telegram/link-token`);
    assert.equal(seen[0].init.method, "POST");
    assert.deepEqual(JSON.parse(seen[0].init.body), { cancelToken: UUID });
    assert.equal(seen[0].init.credentials, "omit");
  });
  test("alreadyLinked:true has no url", async () => {
    stub(200, { url: null, expiresAt: null, alreadyLinked: true });
    assert.deepEqual(await telegramLinkToken(API, UUID), { ok: true, data: { alreadyLinked: true } });
  });
  test("a foreign url is an error, never followed", async () => {
    stub(200, { url: "https://evil.example/x", expiresAt: null, alreadyLinked: false });
    assert.deepEqual(await telegramLinkToken(API, UUID), { ok: false, fail: "error" });
  });
  test("404 = not-found (block removed), 429 = rate-limited, 500 = error", async () => {
    for (const [s, fail] of [[404, "not-found"], [429, "rate-limited"], [500, "error"]]) {
      stub(s, { success: false });
      assert.deepEqual(await telegramLinkToken(API, UUID), { ok: false, fail, status: s });
    }
  });
});

describe("status / unlink", () => {
  test("status", async () => {
    const seen = stub(200, { available: true, linked: true, offerChoice: false });
    assert.deepEqual(await telegramStatus(API, UUID), { ok: true, data: { available: true, linked: true, offerChoice: false } });
    assert.equal(seen[0].url, `${API}/api/v1/book/telegram/status`);
    assert.deepEqual(JSON.parse(seen[0].init.body), { cancelToken: UUID });
  });
  test("status with a malformed body is an error", async () => {
    stub(200, { linked: "yes" });
    assert.equal((await telegramStatus(API, UUID)).ok, false);
  });
  test("unlink: 204 with no body is ok", async () => {
    const seen = stub(204);
    assert.deepEqual(await telegramUnlink(API, UUID), { ok: true, data: true });
    assert.equal(seen[0].url, `${API}/api/v1/book/telegram/unlink`);
    assert.deepEqual(JSON.parse(seen[0].init.body), { cancelToken: UUID });
  });
});

// Minimal fake DOM: just what mountReminders touches.
function fakeDom() {
  const el = (extra = {}) => {
    const h = {};
    return { hidden: false, offsetHeight: 120, style: {}, checked: false, disabled: false, dataset: {}, handlers: h, addEventListener: (t, f) => (h[t] ??= []).push(f), fire: async (t) => { for (const f of h[t] ?? []) await f(); }, ...extra };
  };
  const n = { linked: el(), choice: el(), err: el(), unlink: el(), sms: el({ checked: true }), tg: el(), connect: el({ hidden: true }), gap: el({ hidden: true }), gone: el({ hidden: true }) };
  const errs = ["rate", "fail", "unlink"].map((k) => el({ dataset: { rErr: k } }));
  const map = { "[data-r-linked]": n.linked, "[data-r-choice]": n.choice, "[data-r-error]": n.err, "[data-r-unlink]": n.unlink, 'input[value="sms"]': n.sms, 'input[value="telegram"]': n.tg, "[data-r-connect]": n.connect, "[data-r-connect-gap]": n.gap, "[data-r-unavailable]": n.gone };
  const root = el({ hidden: true, querySelector: (s) => map[s], querySelectorAll: () => errs });
  // a native radio group: choosing one unchecks the other
  const pick = async (a, b) => { a.checked = true; b.checked = false; await a.fire("change"); };
  return { n, root, errs, chooseTg: () => pick(n.tg, n.sms), chooseSms: () => pick(n.sms, n.tg) };
}
const DOC = { visibilityState: "visible", listeners: {}, addEventListener(t, f) { (this.listeners[t] ??= []).push(f); } };
const mount = (dom, telegram, extra = {}) => {
  const calls = { nav: [], ev: [] };
  globalThis.document = DOC;
  globalThis.window = { addEventListener() {} };
  DOC.listeners = {};
  mountReminders({ root: dom.root, api: API, token: UUID, telegram, navigate: (u) => calls.nav.push(u), track: (e) => calls.ev.push(e), ...extra });
  return calls;
};

describe("controller", () => {
  test("offered / errorFor", () => {
    assert.equal(offered({ available: true, linked: false }, UUID), true);
    assert.equal(offered({ available: false, linked: false }, UUID), false);
    assert.equal(offered(null, UUID), false);
    assert.equal(offered({ available: true, linked: false }, null), false);
    assert.equal(errorFor("not-found"), null);
    assert.equal(errorFor("rate-limited"), "rate");
    assert.equal(errorFor("network"), "fail");
  });
  test("available:false -> the block stays hidden, no request", () => {
    const seen = stub(200, {});
    const d = fakeDom();
    mount(d, { available: false, linked: false });
    assert.equal(d.root.hidden, true);
    assert.equal(seen.length, 0);
  });
  test("linked:true -> status + unlink, choice hidden", () => {
    const d = fakeDom();
    mount(d, { available: true, linked: true });
    assert.equal(d.root.hidden, false);
    assert.equal(d.n.linked.hidden, false);
    assert.equal(d.n.choice.hidden, true);
  });
  test("selecting Telegram (arrow key / click) only reveals the connect button: no request, no navigation", async () => {
    const seen = stub(200, {});
    const d = fakeDom();
    const c = mount(d, { available: true, linked: false });
    assert.equal(d.n.connect.hidden, true);
    await d.chooseTg();
    assert.equal(d.n.connect.hidden, false);
    assert.equal(seen.length, 0);
    assert.deepEqual(c.nav, []);
    await d.chooseSms();
    assert.equal(d.n.connect.hidden, true);
    assert.equal(seen.length, 0);
  });
  test("the connect button requests the link and navigates to the backend url", async () => {
    const seen = stub(200, { url: "https://t.me/beautica_app_bot?start=abc", expiresAt: "x", alreadyLinked: false });
    const d = fakeDom();
    const c = mount(d, { available: true, linked: false });
    await d.chooseTg();
    await d.n.connect.fire("click");
    assert.equal(seen.length, 1);
    assert.deepEqual(JSON.parse(seen[0].init.body), { cancelToken: UUID });
    assert.deepEqual(c.nav, ["https://t.me/beautica_app_bot?start=abc"]);
    assert.deepEqual(c.ev, ["reminder_channel_telegram_click"]);
  });
  test("a foreign url is not followed, radio snaps back to SMS", async () => {
    stub(200, { url: "https://evil.example/x", alreadyLinked: false });
    const d = fakeDom();
    const c = mount(d, { available: true, linked: false });
    await d.chooseTg();
    await d.n.connect.fire("click");
    assert.deepEqual(c.nav, []);
    assert.equal(d.n.sms.checked, true);
    assert.equal(d.n.err.hidden, false);
  });
  test("a 404 after the block is shown keeps it (same height) and swaps to the static unavailable line", async () => {
    stub(404, {});
    const d = fakeDom();
    mount(d, { available: true, linked: false });
    await d.chooseTg();
    await d.n.connect.fire("click");
    assert.equal(d.root.hidden, false);
    assert.equal(d.root.style.minHeight, "120px");
    assert.equal(d.n.gone.hidden, false);
    assert.equal(d.n.choice.hidden, true);
  });
  test("two synchronous taps on the connect button send ONE link-token; the controls stay busy while navigating", async () => {
    const seen = stub(200, { url: "https://t.me/beautica_app_bot?start=abc", alreadyLinked: false });
    const d = fakeDom();
    const c = mount(d, { available: true, linked: false });
    await d.chooseTg();
    await Promise.all([d.n.connect.fire("click"), d.n.connect.fire("click")]);
    assert.equal(seen.length, 1);
    assert.equal(c.nav.length, 1);
    assert.equal(d.n.connect.disabled, true);
    assert.equal(d.n.tg.disabled, true);
    seen.length = 0;
    stub(200, { available: true, linked: false, offerChoice: false });
    for (const f of DOC.listeners.visibilitychange) await f();
    assert.equal(d.n.connect.disabled, false);
  });
  test("return from Telegram re-checks status once", async () => {
    const d2 = fakeDom();
    stub(200, { url: "https://t.me/beautica_app_bot?start=abc", alreadyLinked: false });
    mount(d2, { available: true, linked: false });
    await d2.chooseTg();
    await d2.n.connect.fire("click");
    const seen = stub(200, { available: true, linked: true, offerChoice: false });
    for (const f of DOC.listeners.visibilitychange) await f();
    await new Promise((r) => setTimeout(r, 5));
    for (const f of DOC.listeners.visibilitychange) await f();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(seen.length, 1);
    assert.equal(d2.n.linked.hidden, false);
  });
  test("unlink returns to the choice with SMS checked", async () => {
    stub(204);
    const d = fakeDom();
    const c = mount(d, { available: true, linked: true });
    await d.n.unlink.fire("click");
    assert.equal(d.n.choice.hidden, false);
    assert.equal(d.n.sms.checked, true);
    assert.deepEqual(c.ev, ["reminder_channel_unlink"]);
  });
});

describe("salon: which booking carries the block", () => {
  test("the first booking without a cancel path is skipped, the second gets it", () => {
    const offers = [{ token: cancelToken(cancelPath(null)), n: 1 }, { token: cancelToken(cancelPath(`/book/cancel/${UUID}`)), n: 2 }];
    assert.equal(firstWithToken(offers).n, 2);
    assert.equal(firstWithToken([{ token: null }]), null);
    assert.equal(firstWithToken([]), null);
  });
});

describe("wire shape = backend 407 records", backendGate(), () => {
  const dir = join(BACKEND_DIR, "src/main/java/com/beautica/notification/telegram/link/dto");
  const src = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  test("request field", () => assert.match(src("GuestTelegramTokenRequest.java"), /String cancelToken\)/));
  test("link-token response", () => assert.match(src("GuestTelegramLinkResponse.java"), /record GuestTelegramLinkResponse\(String url, Instant expiresAt, boolean alreadyLinked\)/));
  test("status response", () => assert.match(src("GuestTelegramStatusResponse.java"), /record GuestTelegramStatusResponse\(boolean available, boolean linked, boolean offerChoice\)/));
  test("booking block", () => assert.match(src("TelegramAvailability.java"), /boolean available,?\s*boolean linked/));
});

// Phase 024: the cancel page decides from the status answer alone (never the booking source).
test("availabilityFromStatus: offerChoice -> choice, linked -> linked, booking-link guest not linked / unavailable -> nothing", () => {
  assert.deepEqual(availabilityFromStatus({ available: true, linked: false, offerChoice: true }), { available: true, linked: false });
  assert.deepEqual(availabilityFromStatus({ available: true, linked: true, offerChoice: false }), { available: true, linked: true });
  assert.equal(availabilityFromStatus({ available: true, linked: false, offerChoice: false }), null);
  assert.equal(availabilityFromStatus({ available: false, linked: true, offerChoice: true }), null);
});
