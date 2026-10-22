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
import { startMockApi, SVC } from "./helpers/mock-api.mjs";
import { backendGate, javaInt } from "./helpers/backend.mjs";
import { componentsOf, pathProblem, validate } from "./helpers/dto-schema.mjs";
import { ROOT } from "./helpers/env.mjs";
import { parseMasterInfo, parseSalonInfo, parseReviewsPage } from "../src/lib/booking/types.ts";
import { getAvailability, sendOtp, verifyOtp, createBooking } from "../src/scripts/booking/api.ts";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";

const gate = backendGate();
let mock;
before(async () => (mock = await startMockApi()));
after(() => mock?.close());
const get = async (path) => (await fetch(`${mock.origin}${path}`)).json();

const MASTER_SLUGS = ["oksana-ab12", "sparse-0001", "closed-aaaa", "evil-0666", "salonmaster-5555", "rail-8888"];
const SALON_SLUGS = ["lavanda-1111", "shut-2222", "evilsalon-0666"];

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
    assert.equal(Number(/st\.picked\.size >= (\d+)\) return/.exec(app)?.[1]), javaInt("SlotCalculationService", "MAX_SERVICES_PER_VISIT"));
  });
});
