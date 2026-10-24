// Phase 009 QA: the privacy-policy version that every guest consent records. The booking POST and /otp/send send PRIVACY_POLICY_VERSION;
// the backend stores it as "the text the guest agreed to", so it must change exactly when the published text changes.
//   - it equals `updated:` of src/content/legal/uk/privacy.md (the page shows that date),
//   - the policy BODY is pinned by hash in tests/fixtures/privacy-policy-versions.json (one entry per published version):
//     edit the text without bumping the version and this fails; "fix" it by re-pinning the same version and this fails too.
//   - it is not in the future (the backend rejects a future date: PolicyVersionDateValidator, Kyiv calendar day).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";
import { sendOtp, createBooking } from "../src/scripts/booking/api.ts";

const md = readFileSync(join(ROOT, "src/content/legal/uk/privacy.md"), "utf8");
const body = md.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/\r\n/g, "\n");
const hash = createHash("sha256").update(body).digest("hex");
const pins = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/privacy-policy-versions.json"), "utf8")).versions;

describe("privacy policy version", () => {
  test("PRIVACY_POLICY_VERSION equals the `updated:` date shown on /privacy", () => {
    assert.equal(/^updated: (\S+)/m.exec(md)[1], PRIVACY_POLICY_VERSION);
  });
  test("the current policy text is the one pinned for this version (text changed => bump `updated:` + PRIVACY_POLICY_VERSION + add a pin)", () => {
    const pin = pins.at(-1);
    assert.equal(pin.version, PRIVACY_POLICY_VERSION, "the newest pin is not the current version: add {version, sha256} for it");
    assert.equal(hash, pin.sha256, `privacy.md changed (sha256 ${hash.slice(0, 12)}…) but the version is still ${PRIVACY_POLICY_VERSION}: bump it, then pin the new hash under the NEW version`);
  });
  test("pins are strictly increasing versions, one hash each (a re-pin under an old version is rejected)", () => {
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
