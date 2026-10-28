// Phase 008/009 QA: the site <-> backend contract for the guest-booking endpoints, compared against the backend's Java records
// (a sibling repo, read as source), not against our own mock's idea of them. Three directions:
//   1. every response the MOCK BACKEND serves is a legal instance of the real DTO (field names, types, enums, nullability),
//   2. every field the SITE READS from a response exists in the real DTO (traced through the real parsers with a recording Proxy),
//   3. every request the SITE SENDS carries only real fields, all required ones, values that satisfy the DTO's @Size/@Pattern.
// Drift on either side (a renamed field in the backend, a stale mock, a typo in a parser) fails here. No server, no browser.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startMockApi, SVC, WIZ, wizAssign } from "./helpers/mock-api.mjs";
import { backendGate, javaInt } from "./helpers/backend.mjs";
import { componentsOf, pathProblem, validate } from "./helpers/dto-schema.mjs";
import { ROOT, TEST_NOW } from "./helpers/env.mjs";
import { parseMasterInfo, parseSalonInfo, parseReviewsPage } from "../src/lib/booking/types.ts";
import { getAvailability, getBookableDays, sendOtp, verifyOtp, createBooking } from "../src/scripts/booking/api.ts";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";

const gate = backendGate();
let mock;
before(async () => (mock = await startMockApi()));
after(() => mock?.close());
const get = async (path) => (await fetch(`${mock.origin}${path}`)).json();

const MASTER_SLUGS = ["oksana-ab12", "sparse-0001", "closed-aaaa", "evil-0666", "salonmaster-5555", "rail-8888"];
const SALON_SLUGS = ["lavanda-1111", "shut-2222", "evilsalon-0666", "wiz-contract-0001"];

describe("1. the mock backend only serves what the real DTOs allow", gate, () => {
  for (const slug of MASTER_SLUGS)
    test(`GET /book/${slug}/info is a BookingSlugInfoResponse`, async () => assert.deepEqual(validate(await get(`/api/v1/book/${slug}/info`), "BookingSlugInfoResponse"), []));
  for (const slug of SALON_SLUGS)
    test(`GET /book/s/${slug}/info is a SalonBookingSlugInfoResponse`, async () => assert.deepEqual(validate(await get(`/api/v1/book/s/${slug}/info`), "SalonBookingSlugInfoResponse"), []));
  test("GET /book/{slug}/reviews is a PageResponse<ReviewResponse>", async () => assert.deepEqual(validate(await get("/api/v1/book/oksana-ab12/reviews"), "PageResponse<ReviewResponse>"), []));
  test("GET /book/s/{slug}/reviews is a PageResponse<SalonReviewResponse>", async () => assert.deepEqual(validate(await get("/api/v1/book/s/lavanda-1111/reviews"), "PageResponse<SalonReviewResponse>"), []));
  test("GET /availability is a List<AvailableSlotResponse>", async () => {
    const slots = await get(`/api/v1/book/oksana-ab12/availability?date=2030-01-02&serviceId=${SVC[0].id}`);
    assert.ok(slots.length > 0);
    assert.deepEqual(validate(slots, "List<AvailableSlotResponse>"), []);
  });
  test("GET /bookable-days is a List<MasterWorkingDayResponse>", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(TEST_NOW));
    const days = await get(`/api/v1/book/oksana-ab12/bookable-days?from=${today}&to=${today}&serviceId=${SVC[0].id}`);
    assert.equal(days.length, 1);
    assert.deepEqual(validate(days, "List<MasterWorkingDayResponse>"), []);
  });
  test("salon wizard routes (backend 392/393): availability and bookable-days are the master-slug DTOs, the booking is a GuestBookingResponse", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(TEST_NOW));
    const base = `/api/v1/book/s/wiz-contract-0001/masters/${WIZ.masters[0].id}`;
    const slots = await get(`${base}/availability?date=2030-01-02&serviceId=${wizAssign(1, 2)}`);
    assert.ok(slots.length > 0);
    assert.deepEqual(validate(slots, "List<AvailableSlotResponse>"), []);
    const days = await get(`${base}/bookable-days?from=${today}&to=${today}&serviceId=${wizAssign(1, 2)}`);
    assert.equal(days.length, 1);
    assert.deepEqual(validate(days, "List<MasterWorkingDayResponse>"), []);
    const res = await fetch(`${mock.origin}${base}/booking`, { method: "POST", headers: { authorization: "Bearer guest-token-ok" }, body: JSON.stringify({ masterServiceIds: [wizAssign(1, 2)], startsAt: "2030-01-02T10:00:00+02:00", name: "А", surname: "Б", privacyAccepted: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION }) });
    assert.equal(res.status, 201);
    assert.deepEqual(validate(await res.json(), "GuestBookingResponse"), []);
    // a service id that is not this master's assignment is not served (the real backend answers 404 as well)
    assert.equal((await fetch(`${mock.origin}${base}/availability?date=2030-01-02&serviceId=${wizAssign(2, 3)}`)).status, 404);
  });
  test("POST /otp/verify is an ApiResponse<GuestTokenResponse>", async () => {
    const res = await fetch(`${mock.origin}/api/v1/book/otp/verify`, { method: "POST", body: JSON.stringify({ phone: "+380501234567", code: "123456" }) });
    assert.deepEqual(validate(await res.json(), "ApiResponse<GuestTokenResponse>"), []);
  });
  test("POST /booking (201) is a GuestBookingResponse", async () => {
    const res = await fetch(`${mock.origin}/api/v1/book/oksana-ab12/booking`, {
      method: "POST",
      headers: { authorization: "Bearer guest-token-ok" },
      body: JSON.stringify({ serviceId: SVC[0].id, startsAt: "2030-01-02T10:00:00+02:00", name: "А", surname: "Б", privacyAccepted: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(validate(await res.json(), "GuestBookingResponse"), []);
  });
  test("the validator itself bites: a renamed field and a wrong type are reported", () => {
    const m = { masterName: "A", masterID: "x", reviewCount: "3" };
    const problems = validate(m, "BookingSlugInfoResponse");
    assert.ok(problems.some((p) => p.includes('"masterID" is not a field')), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("reviewCount") && p.includes("expected number")), problems.join("\n"));
  });
});

/** Wraps JSON so every property the code reads is recorded as a path ("services[].priceFrom"). */
function traced(value, reads, path = "") {
  if (Array.isArray(value)) return new Proxy(value.map((v) => traced(v, reads, `${path}[]`)), {});
  if (value === null || typeof value !== "object") return value;
  return new Proxy(value, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "toJSON" || prop === "then") return Reflect.get(target, prop, receiver);
      const p = path ? `${path}.${prop}` : prop;
      reads.add(p);
      return traced(target[prop], reads, p);
    },
  });
}
/** Keeps only the leaf-most reads that name a real chain (the recorder also logs a parent when a child is read). */
const readsOf = (fn) => {
  const reads = new Set();
  fn(reads);
  return [...reads];
};

describe("2. every field the site reads exists in the real DTO", gate, () => {
  for (const slug of ["oksana-ab12", "salonmaster-5555"])
    test(`parseMasterInfo (${slug}) reads only BookingSlugInfoResponse fields`, async () => {
      const raw = await get(`/api/v1/book/${slug}/info`);
      const reads = readsOf((r) => assert.ok(parseMasterInfo(slug, traced(raw, r))));
      assert.ok(reads.length > 15, `the trace saw ${reads.length} reads: the recorder is broken`);
      // parseReviews is shared with the salon page: it also looks for masterFirstName/LastName, which only SalonReviewResponse has (absent = fine).
      const tolerated = /^latestReviews\[\]\.master(First|Last)Name$/;
      assert.deepEqual(reads.filter((p) => !tolerated.test(p)).map((p) => pathProblem(p, "BookingSlugInfoResponse")).filter(Boolean), []);
    });
  test("parseSalonInfo reads only SalonBookingSlugInfoResponse fields", async () => {
    const raw = await get("/api/v1/book/s/lavanda-1111/info");
    const reads = readsOf((r) => assert.ok(parseSalonInfo("lavanda-1111", traced(raw, r))));
    assert.ok(reads.length > 15);
    assert.deepEqual(reads.map((p) => pathProblem(p, "SalonBookingSlugInfoResponse")).filter(Boolean), []);
  });
  test("parseSalonInfo on the wizard fixture reads masterId and serviceCoverage[].masters[] that SalonBookingSlugInfoResponse really has", async () => {
    const raw = await get("/api/v1/book/s/wiz-contract-0001/info");
    const reads = readsOf((r) => assert.ok(parseSalonInfo("wiz-contract-0001", traced(raw, r))));
    for (const needed of ["masters[].masterId", "serviceCoverage[].serviceId", "serviceCoverage[].masters[].masterId", "serviceCoverage[].masters[].masterServiceId", "serviceCategories[].services[].priceMin"]) assert.ok(reads.includes(needed), `the parser never read ${needed}`);
    assert.deepEqual(reads.map((p) => pathProblem(p, "SalonBookingSlugInfoResponse")).filter(Boolean), []);
    const info = parseSalonInfo("wiz-contract-0001", raw);
    assert.equal(info.masters[0].masterSlug, null, "a master without a personal link is kept, with masterSlug null");
    assert.equal(info.masters.length, 3);
  });
  for (const [kind, url, type] of [["master", "/api/v1/book/oksana-ab12/reviews", "PageResponse<ReviewResponse>"], ["salon", "/api/v1/book/s/lavanda-1111/reviews", "PageResponse<SalonReviewResponse>"]])
    test(`parseReviewsPage (${kind}) reads only ${type} fields`, async () => {
      const raw = await get(url);
      const reads = readsOf((r) => assert.ok(parseReviewsPage(traced(raw, r))));
      assert.ok(reads.length > 5);
      // parseReviews is shared by both kinds: the master reviews have no master name (it is the page's own master), the salon ones do.
      const tolerated = kind === "master" ? /data\[\]\.master(First|Last)Name/ : /^$/;
      assert.deepEqual(reads.filter((p) => !tolerated.test(p)).map((p) => pathProblem(p, type)).filter(Boolean), []);
    });
  test("getAvailability / verifyOtp / createBooking read only AvailableSlotResponse / GuestTokenResponse / GuestBookingResponse fields", async () => {
    const real = globalThis.fetch;
    const reads = { slots: new Set(), token: new Set(), booking: new Set() };
    const bookingPayload = await (await fetch(`${mock.origin}/api/v1/book/oksana-ab12/booking`, { method: "POST", headers: { authorization: "Bearer guest-token-ok" }, body: JSON.stringify({ serviceId: SVC[0].id, startsAt: "2030-01-02T10:00:00+02:00", name: "А", surname: "Б", privacyAccepted: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION }) })).json();
    const slotsPayload = await get(`/api/v1/book/oksana-ab12/availability?date=2030-01-02&serviceId=${SVC[0].id}`);
    const answer = (payload, set) => async () => ({ ok: true, status: 200, json: async () => traced(payload, set) });
    try {
      globalThis.fetch = answer(slotsPayload, reads.slots);
      assert.equal((await getAvailability("http://x", "oksana-ab12", "2030-01-02", [SVC[0].id])).ok, true);
      globalThis.fetch = answer({ success: true, data: { guestToken: "t" }, message: null }, reads.token);
      assert.equal((await verifyOtp("http://x", "+380501234567", "123456")).ok, true);
      globalThis.fetch = answer(bookingPayload, reads.booking);
      const r = await createBooking("http://x", "oksana-ab12", "tok", { serviceIds: [SVC[0].id], startsAt: "2030-01-02T10:00:00+02:00", name: "А", surname: "Б", policyVersion: PRIVACY_POLICY_VERSION });
      assert.equal(r.ok, true);
    } finally {
      globalThis.fetch = real;
    }
    for (const [set, type] of [[reads.slots, "List<AvailableSlotResponse>"], [reads.token, "ApiResponse<GuestTokenResponse>"], [reads.booking, "GuestBookingResponse"]]) {
      assert.ok(set.size >= 1, `${type}: nothing was read`);
      assert.deepEqual([...set].map((p) => pathProblem(p, type)).filter(Boolean), [], type);
    }
  });
  test("getBookableDays reads only MasterWorkingDayResponse fields", async () => {
    const real = globalThis.fetch;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(TEST_NOW));
    const payload = await get(`/api/v1/book/oksana-ab12/bookable-days?from=${today}&to=${today}&serviceId=${SVC[0].id}`);
    const reads = new Set();
    try {
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => traced(payload, reads) });
      const r = await getBookableDays("http://x", "oksana-ab12", today, today, [SVC[0].id]);
      assert.equal(r.ok && r.data.length, 1);
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(reads.size >= 1, "nothing was read");
    assert.deepEqual([...reads].map((p) => pathProblem(p, "List<MasterWorkingDayResponse>")).filter(Boolean), []);
  });
  test("a slug is percent-encoded in every API URL (no path traversal or query injection)", async () => {
    const real = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (u) => (urls.push(String(u)), { ok: true, status: 200, json: async () => [] });
    try {
      for (const slug of ["a/../b", "x?y=1#z"]) {
        await getAvailability("http://x", slug, "2030-01-02", [SVC[0].id]);
        await getBookableDays("http://x", slug, "2030-01-02", "2030-01-03", [SVC[0].id]);
        await createBooking("http://x", slug, "tok", { serviceIds: [SVC[0].id], startsAt: "2030-01-02T10:00:00+02:00", name: "А", surname: "Б", policyVersion: PRIVACY_POLICY_VERSION });
      }
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(urls.length, 6);
    for (const u of urls) {
      const path = new URL(u).pathname;
      assert.match(path, /^\/api\/v1\/book\/(a%2F\.\.%2Fb|x%3Fy%3D1%23z)\/(availability|bookable-days|booking)$/, u);
    }
  });
  test("the server-side info loaders encode their slug", () => {
    const src = readFileSync(join(ROOT, "src/lib/booking/info.ts"), "utf8");
    assert.equal((src.match(/\$\{encodeURIComponent\(slug\)\}/g) ?? []).length, 3);
    assert.equal(/\$\{slug\}/.test(src.replace(/parse\w+\(slug/g, "")), false, "no raw slug in a URL");
  });
  test("the reviews loader encodes its slug too", () => {
    const src = readFileSync(join(ROOT, "src/scripts/booking/reviews.ts"), "utf8");
    assert.match(src, /\$\{encodeURIComponent\(slug\)\}\/reviews\?/);
  });
  test("the recorder bites: a field the backend does not have is reported", () => {
    const reads = new Set();
    traced({ masterName: "A", mastername: "x" }, reads).mastername;
    assert.ok(pathProblem([...reads][0], "BookingSlugInfoResponse")?.includes("no such field"));
  });
});

/** Constraints a record component declares: required, max length, regexes (Java -> JS), min length. */
function constraints(c) {
  const a = c.annotations;
  const size = /@Size\(([^)]*)\)/.exec(a)?.[1] ?? "";
  const bound = (k) => {
    const v = new RegExp(`${k}\\s*=\\s*([\\w.]+)`).exec(size)?.[1];
    return v === undefined ? null : /^\d+$/.test(v) ? Number(v) : javaInt(v.split(".")[0], v.split(".")[1]);
  };
  const patterns = [...a.matchAll(/regexp\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => new RegExp(`^(?:${m[1].replace(/\\\\/g, "\\").replace(/\\p\{Cntrl\}/g, "\\x00-\\x1F\\x7F").replace(/^\^|\$$/g, "")})$`, "u"));
  return { required: /@NotBlank|@NotNull/.test(a), max: bound("max"), min: bound("min"), patterns };
}
/** Fails when `body` is not a legal instance of the request record `type`. */
function requestProblems(body, type) {
  const comps = componentsOf(type);
  const problems = [];
  for (const k of Object.keys(body)) if (!comps.some((c) => c.name === k)) problems.push(`${type}: the site sends "${k}", the backend has no such field`);
  for (const c of comps) {
    const k = constraints(c);
    const v = body[c.name];
    if (v === undefined) {
      if (k.required) problems.push(`${type}.${c.name} is required by the backend but not sent`);
      continue;
    }
    if (typeof v === "string") {
      if (k.max !== null && v.length > k.max) problems.push(`${type}.${c.name} longer than ${k.max}`);
      if (k.min !== null && v.length < k.min) problems.push(`${type}.${c.name} shorter than ${k.min}`);
      for (const re of k.patterns) if (!re.test(v)) problems.push(`${type}.${c.name} ${JSON.stringify(v)} violates ${re}`);
    }
    if (Array.isArray(v) && k.max !== null && v.length > k.max) problems.push(`${type}.${c.name} has more than ${k.max} items`);
  }
  return problems;
}

describe("3. every request the site sends is a legal backend request", gate, () => {
  const sent = [];
  const real = globalThis.fetch;
  before(() => {
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ success: true, data: { guestToken: "t" }, startsAt: "2030-01-02T10:00:00+02:00" }) };
    };
  });
  after(() => (globalThis.fetch = real));
  const last = () => sent.at(-1);

  test("POST /otp/send matches PhoneOtpSendRequest (phone format, consent, policy version, Turnstile token <= 2048)", async () => {
    await sendOtp("http://x", "+380501234567", PRIVACY_POLICY_VERSION, "TOKEN-1");
    assert.equal(last().url, "http://x/api/v1/book/otp/send");
    assert.deepEqual(requestProblems(last().body, "PhoneOtpSendRequest"), []);
    assert.equal(last().body.privacyAccepted, true);
  });
  test("POST /otp/send without a Turnstile token (local backend) omits the field instead of sending null", async () => {
    await sendOtp("http://x", "+380501234567", PRIVACY_POLICY_VERSION, null);
    assert.equal("turnstileToken" in last().body, false);
    assert.deepEqual(requestProblems(last().body, "PhoneOtpSendRequest"), []);
  });
  test("POST /otp/verify matches PhoneOtpVerifyRequest", async () => {
    await verifyOtp("http://x", "+380501234567", "123456");
    assert.deepEqual(requestProblems(last().body, "PhoneOtpVerifyRequest"), []);
  });
  test("POST /booking, one service: serviceId only, matches GuestBookingRequest", async () => {
    await createBooking("http://x", "oksana-ab12", "tok", { serviceIds: [SVC[0].id], startsAt: "2030-01-02T10:00:00+02:00", name: "Марина", surname: "Коваленко", policyVersion: PRIVACY_POLICY_VERSION });
    assert.deepEqual(requestProblems(last().body, "GuestBookingRequest"), []);
    assert.equal(last().body.serviceId, SVC[0].id);
    assert.equal("masterServiceIds" in last().body, false, "exactly one of serviceId / masterServiceIds");
    assert.equal(last().init.headers.Authorization, "Bearer tok");
  });
  test("POST /booking, several services: masterServiceIds only, up to the backend's cap", async () => {
    const cap = javaInt("SlotCalculationService", "MAX_SERVICES_PER_VISIT");
    const ids = Array.from({ length: cap }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`);
    await createBooking("http://x", "oksana-ab12", "tok", { serviceIds: ids, startsAt: "2030-01-02T10:00:00+02:00", name: "М", surname: "К", policyVersion: PRIVACY_POLICY_VERSION });
    assert.deepEqual(requestProblems(last().body, "GuestBookingRequest"), []);
    assert.equal("serviceId" in last().body, false);
    assert.equal(last().body.masterServiceIds.length, cap);
  });
  test("POST /book/s/{slug}/masters/{id}/booking: masterServiceIds always (even for one service), no serviceId, on the salon route, matches GuestBookingRequest", async () => {
    const id = WIZ.masters[1].id;
    await createBooking("http://x", "wiz-contract-0001", "tok", { serviceIds: [wizAssign(2, 3)], startsAt: "2030-01-02T10:00:00+02:00", name: "М", surname: "К", policyVersion: PRIVACY_POLICY_VERSION, clientComment: "Для Ірини" }, id);
    assert.equal(last().url, `http://x/api/v1/book/s/wiz-contract-0001/masters/${id}/booking`);
    assert.deepEqual(requestProblems(last().body, "GuestBookingRequest"), []);
    assert.deepEqual(last().body.masterServiceIds, [wizAssign(2, 3)]);
    assert.equal("serviceId" in last().body, false);
    assert.equal(last().init.headers.Authorization, "Bearer tok");
  });
  test("salon availability / bookable-days URLs carry the master id and the assignment ids as serviceId", async () => {
    const id = WIZ.masters[0].id;
    await getAvailability("http://x", "wiz-contract-0001", "2030-01-02", [wizAssign(1, 1), wizAssign(1, 2)], id);
    assert.equal(last().url, `http://x/api/v1/book/s/wiz-contract-0001/masters/${id}/availability?date=2030-01-02&serviceId=${wizAssign(1, 1)}&serviceId=${wizAssign(1, 2)}`);
    await getBookableDays("http://x", "wiz-contract-0001", "2030-01-02", "2030-01-09", [wizAssign(1, 1)], id);
    assert.equal(last().url, `http://x/api/v1/book/s/wiz-contract-0001/masters/${id}/bookable-days?from=2030-01-02&to=2030-01-09&serviceId=${wizAssign(1, 1)}`);
  });
  test("POST /booking: clientComment is sent only when non-blank, and within the backend's limit", async () => {
    const base = { serviceIds: [SVC[0].id], startsAt: "2030-01-02T10:00:00+02:00", name: "М", surname: "К", policyVersion: PRIVACY_POLICY_VERSION };
    await createBooking("http://x", "oksana-ab12", "tok", base);
    assert.equal("clientComment" in last().body, false);
    await createBooking("http://x", "oksana-ab12", "tok", { ...base, clientComment: "" });
    assert.equal("clientComment" in last().body, false, "an empty comment is omitted, never sent as \"\"");
    await createBooking("http://x", "oksana-ab12", "tok", { ...base, clientComment: "Прийду з дитиною\nдякую" });
    assert.deepEqual(requestProblems(last().body, "GuestBookingRequest"), []);
    assert.equal(last().body.clientComment, "Прийду з дитиною\nдякую");
  });
  test("the request checker bites: a bad version, a stray field and a missing consent are reported", () => {
    const p = requestProblems({ serviceId: SVC[0].id, startsAt: "x", name: "A", surname: "B", privacyPolicyVersion: "22.10.2026", comment: "hi" }, "GuestBookingRequest");
    assert.ok(p.some((x) => x.includes("privacyPolicyVersion") && x.includes("violates")), p.join("\n"));
    assert.ok(p.some((x) => x.includes('"comment"')), p.join("\n"));
    assert.ok(p.some((x) => x.includes("privacyAccepted is required")), p.join("\n"));
  });
});

describe("3b. form limits on the page never exceed what the backend accepts", gate, () => {
  const html = readFileSync(join(ROOT, "src/components/book/BookingFlow.astro"), "utf8");
  const maxlength = (id) => Number(new RegExp(`id="${id}"[^>]*maxlength="(\\d+)"`).exec(html)?.[1]);
  const dto = (field) => constraints(componentsOf("GuestBookingRequest").find((c) => c.name === field));
  test("name and surname maxlength <= GuestBookingRequest @Size", () => {
    for (const f of ["name", "surname"]) {
      assert.ok(maxlength(f) > 0, `no maxlength on #${f}`);
      assert.ok(maxlength(f) <= dto(f).max, `#${f} allows ${maxlength(f)}, the backend ${dto(f).max}`);
    }
  });
  test("comment maxlength is 500 (the app's limit) and <= the backend's 1000", () => {
    assert.equal(maxlength("comment"), 500);
    assert.ok(maxlength("comment") <= dto("clientComment").max);
  });
  test("the service picker's cap equals the backend's MAX_SERVICES_PER_VISIT", () => {
    const app = readFileSync(join(ROOT, "src/scripts/booking/app.ts"), "utf8");
    assert.equal(Number(/st\.picked\.size >= (\d+)\)/.exec(app)?.[1]), javaInt("SlotCalculationService", "MAX_SERVICES_PER_VISIT"));
  });
  test("the salon wizard's per-master comment box allows 500 characters as well", () => {
    assert.match(html, /<textarea rows="3" maxlength="500"[^>]*data-appt-text/);
  });
});
