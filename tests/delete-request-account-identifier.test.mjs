// W042/W043 QA (SUP-21, SUP-45, SUP-46). No server, no browser, no network: bundles src/lib/deleteRequest.ts with esbuild and reads dist/client,
// the policy source and docs/claims.md. Runs in `npm run test:static` and in `npm test`.
//   1. validate(): the «email» field takes an email OR a UA mobile, normalised to E.164 (0…, spaces, dashes, +380…, 380…); junk and non-UA refused
//   2. buildMessage(): a phone-only account has no Reply-To and its number is shown; an email account keeps Reply-To
//   3. the form: label «Email або телефон акаунта», a text input (type=email would block a phone in the browser)
//   4. the policy states SMSClub as the SMS processor and guest-only booking SMS, and the ledger rows for both exist
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ROOT, uk } from "./helpers/env.mjs";

const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const out = join(mkdtempSync(join(tmpdir(), "dr-account-")), "deleteRequest.mjs");
await build({ entryPoints: [join(ROOT, "src/lib/deleteRequest.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const { validate, buildMessage, buildBody } = await import(pathToFileURL(out).href);

const form = (over = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ email: "client@example.com", phone: "", role: "client", comment: "", consent: "on", ...over })) f.set(k, v);
  return f;
};
const NOW = new Date("2026-11-19T10:00:00Z");

describe("validate(): the account identifier is an email or a Ukrainian mobile number", () => {
  for (const typed of ["0501234567", "050 123-45-67", "+380501234567", "+380 (50) 123-45-67", "380501234567", "  050 123 45 67  "]) {
    test(`the phone «${typed}» is accepted and becomes +380501234567`, () => {
      const r = validate(form({ email: typed }));
      assert.equal(r.ok, true);
      assert.equal(r.value.accountPhone, "+380501234567");
      assert.equal(r.value.email, "");
    });
  }
  test("an email is kept as typed, no account phone", () => {
    const r = validate(form({ email: "Client@Example.com" }));
    assert.equal(r.ok, true);
    assert.equal(r.value.email, "Client@Example.com");
    assert.equal(r.value.accountPhone, "");
  });
  for (const [name, typed] of [
    ["too few digits", "12345"],
    ["a non-UA number", "+48123456789"],
    ["+ before the trunk 0", "+0501234567"],
    ["letters", "abc"],
    ["an incomplete UA number", "050 123 45"],
    ["an email without a dot in the domain", "a@b"],
    ["a longer-than-limit phone string", `+380${"5".repeat(40)}`],
  ]) {
    test(`${name} («${typed.slice(0, 20)}») is refused on «email»`, () => {
      const r = validate(form({ email: typed }));
      assert.equal(r.ok, false);
      assert.deepEqual(r.fields, ["email"]);
    });
  }
  test("the contact phone field is independent of the account phone", () => {
    const r = validate(form({ email: "0501234567", phone: "0671112233" }));
    assert.equal(r.value.accountPhone, "+380501234567");
    assert.equal(r.value.phone, "+380671112233");
  });
});

describe("buildMessage(): the team email for a phone-only account", () => {
  const phoneOnly = validate(form({ email: "050 123 45 67" })).value;
  const emailOnly = validate(form({ email: "client@example.com" })).value;
  test("has no Reply-To (there is no address to reply to)", () => {
    assert.equal("replyTo" in buildMessage(phoneOnly, NOW), false);
  });
  test("shows the E.164 number on the «Email або телефон акаунта» line", () => {
    assert.match(buildBody(phoneOnly, NOW), /^Email або телефон акаунта: \+380501234567$/m);
    assert.doesNotMatch(buildBody(phoneOnly, NOW), /undefined|null/);
  });
  test("an email account keeps Reply-To = the email and shows it on the same line", () => {
    assert.equal(buildMessage(emailOnly, NOW).replyTo, "client@example.com");
    assert.match(buildBody(emailOnly, NOW), /^Email або телефон акаунта: client@example\.com$/m);
  });
});

describe("/delete-account: the form asks for an email or a phone", () => {
  const html = read0("delete-account");
  function read0(p) {
    return readFileSync(join(DIST, `${p}.html`), "utf8");
  }
  test("the label reads «Email або телефон акаунта» (uk.json and the built page)", () => {
    assert.equal(uk.deleteRequest.email, "Email або телефон акаунта");
    assert.match(html, /<label[^>]*for="dr-email"[^>]*>Email або телефон акаунта<\/label>/);
  });
  test("the field is type=text: type=email would make the browser refuse a phone", () => {
    assert.match(html, /<input id="dr-email" name="email" type="text"/);
  });
  test("the error message names both an email and a UA phone", () => {
    assert.equal(uk.deleteRequest.errEmail, "Вкажіть коректну пошту або український номер телефону.");
  });
});

describe("the policy facts of W043 and their ledger rows", () => {
  const md = read("src/content/legal/uk/privacy.md");
  const ledger = read("docs/claims.md").split("\n").filter((l) => l.startsWith("|") && !/^\|\s*(claim|-)/.test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  test("the policy names SMSClub as the SMS processor and no longer names Turbosms", () => {
    assert.match(md, /- \*\*SMSClub\*\* \(ТОВ «Нейро Сфера»/);
    assert.doesNotMatch(md, /turbosms/i);
  });
  test("the policy says booking SMS go only to guests, accounts get the app and email", () => {
    assert.match(md, /SMS про записи отримують лише гості \(запис без акаунта\); користувачам з акаунтом повідомлення про записи надходять у застосунку та листом/);
  });
  for (const [name, claim, anchor, source] of [
    ["SMSClub", /SMSClub/, "privacy#recipients", /SmsClubProperties\.java:\d+/],
    ["guest-only booking SMS", /booking SMS.*only to guests|only to guests/i, "privacy#data", /GuestMessageKind\.java:\d+/],
  ]) {
    test(`a live ledger row backs «${name}» (${anchor})`, () => {
      const row = ledger.find((r) => claim.test(r[0]) && r[1] === anchor);
      assert.ok(row, `no ledger row for ${name} at ${anchor}`);
      assert.equal(row[3], "live");
      assert.match(row[2], source);
    });
  }
});
