// Phase 009 QA: the privacy-policy version that every guest consent records. The booking POST and /otp/send send PRIVACY_POLICY_VERSION;
// the backend stores it as "the text the guest agreed to", so it must change exactly when the published text changes.
//   - it equals `updated:` of src/content/legal/uk/privacy.md (the page shows that date),
//   - the policy BODY is pinned by hash in tests/fixtures/privacy-policy-versions.json (one entry per published version):
//     edit the text without bumping the version and this fails. Rewriting the hash of an already published version is caught by
//     tests/legal-pins-append-only.test.mjs (compares the fixtures with the PR base branch), not here.
//   - it is not in the future (the backend rejects a future date: PolicyVersionDateValidator, Kyiv calendar day).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { PRIVACY_POLICY_VERSION, TERMS_VERSION } from "../src/config/legal.mjs";
import { privacyDigest, termsDigest } from "./helpers/legal-pin.mjs";
import { sendOtp, createBooking } from "../src/scripts/booking/api.ts";

// One helper for both legal pins: the document, its digest (privacy: body only; terms: rendered text, see tests/helpers/legal-pin.mjs) and its fixture pins.
const legalPin = (doc, fixture, digest) => {
  const md = readFileSync(join(ROOT, `src/content/legal/uk/${doc}.md`), "utf8");
  return { md, hash: digest(md), pins: JSON.parse(readFileSync(join(ROOT, `tests/fixtures/${fixture}`), "utf8")).versions };
};
const { md, hash, pins } = legalPin("privacy", "privacy-policy-versions.json", privacyDigest);

describe("privacy policy version", () => {
  test("PRIVACY_POLICY_VERSION equals the `updated:` date shown on /privacy", () => {
    assert.equal(/^updated: (\S+)/m.exec(md)[1], PRIVACY_POLICY_VERSION);
  });
  test("the current policy text is the one pinned for this version (text changed => bump `updated:` + PRIVACY_POLICY_VERSION + add a pin)", () => {
    const pin = pins.at(-1);
    assert.equal(pin.version, PRIVACY_POLICY_VERSION, "the newest pin is not the current version: add {version, sha256} for it");
    assert.equal(hash, pin.sha256, `privacy.md changed (sha256 ${hash.slice(0, 12)}…) but the version is still ${PRIVACY_POLICY_VERSION}: bump it, then pin the new hash under the NEW version`);
  });
  test("pins are sorted, one version and one hash each (append-only vs the base branch: tests/legal-pins-append-only.test.mjs)", () => {
    const versions = pins.map((p) => p.version);
    assert.deepEqual(versions, [...versions].sort(), "versions must be sorted");
    assert.equal(new Set(versions).size, versions.length, "a version was pinned twice");
    assert.equal(new Set(pins.map((p) => p.sha256)).size, pins.length, "two versions share one text");
  });
  test("is a date not in the future (Kyiv calendar day), in the backend's format", () => {
    assert.match(PRIVACY_POLICY_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d{1,3})?$/);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
    assert.ok(PRIVACY_POLICY_VERSION.slice(0, 10) <= today, `${PRIVACY_POLICY_VERSION} is after today (${today}): the backend answers 400`);
  });
});

// Terms pin (phase 037): registration consent records the terms version, so any change to what /terms renders (title, metaTitle, description,
// body incl. hidden comments, and the {{operator}}/{{operatorDetails}} values from legal.mjs) must come with a version bump and a new pin under the NEW version. Mobile kTermsVersion is a manual pair (no cross-repo check).
describe("terms version", () => {
  const t = legalPin("terms", "terms-versions.json", termsDigest);
  test("TERMS_VERSION equals the `updated:` date of terms.md", () => {
    assert.equal(/^updated: (\S+)/m.exec(t.md)[1], TERMS_VERSION);
  });
  test("the current terms text is the one pinned for this version (text changed => bump `updated:` + TERMS_VERSION + add a pin)", () => {
    const pin = t.pins.at(-1);
    assert.equal(pin.version, TERMS_VERSION, "the newest pin is not the current version: add {version, sha256} for it");
    assert.equal(t.hash, pin.sha256, `terms (terms.md title/metaTitle/description/body or legal.mjs operator values) changed (sha256 ${t.hash.slice(0, 12)}…) but the version is still ${TERMS_VERSION}: bump it, then pin the new hash under the NEW version`);
  });
  test("pins are sorted, one version and one hash each (append-only vs the base branch: tests/legal-pins-append-only.test.mjs)", () => {
    const versions = t.pins.map((p) => p.version);
    assert.deepEqual(versions, [...versions].sort(), "versions must be sorted");
    assert.equal(new Set(versions).size, versions.length, "a version was pinned twice");
    assert.equal(new Set(t.pins.map((p) => p.sha256)).size, t.pins.length, "two versions share one text");
  });
  test("is a date not in the future (Kyiv calendar day), in the backend's format", () => {
    assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}(\.\d{1,3})?$/);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
    assert.ok(TERMS_VERSION.slice(0, 10) <= today, `${TERMS_VERSION} is after today (${today}): the backend rejects a future date`);
  });
});

describe("the version reaches the wire unchanged", () => {
  const real = globalThis.fetch;
  test("/otp/send and the booking POST both carry exactly the version they were given, with privacyAccepted: true", async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => (bodies.push(JSON.parse(init.body)), { ok: true, status: 200, json: async () => ({}) });
    try {
      await sendOtp("http://x", "+380501234567", PRIVACY_POLICY_VERSION, null);
      await createBooking("http://x", "a-b", "t", { serviceIds: ["i"], startsAt: "s", name: "n", surname: "s", policyVersion: PRIVACY_POLICY_VERSION });
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(bodies.length, 2);
    for (const b of bodies) {
      assert.equal(b.privacyPolicyVersion, PRIVACY_POLICY_VERSION);
      assert.equal(b.privacyAccepted, true);
    }
  });
  test("the SSR page wires the config value into the island (data-policy) and nothing else", () => {
    const page = readFileSync(join(ROOT, "src/pages/book/[slug].astro"), "utf8");
    assert.match(page, /data-policy=\{cfg\.policyVersion\}/);
    assert.match(readFileSync(join(ROOT, "src/lib/booking/config.ts"), "utf8"), /policyVersion: PRIVACY_POLICY_VERSION/);
  });
});
