// Phase 028 QA (privacy 1.7, in-app crash reports via Sentry). No server, no browser, no network: reads dist/client, the policy source and
// (when the mobile repo is checked out) the mobile ARB. Runs in `npm run test:static`.
//   1. the built /privacy carries the crash-report subsection (§2), the Sentry recipient (§6), the DPF/SCC paragraph (§7), the 30-day retention (§8)
//   2. the opt-out switch label the policy quotes == mobile ARB accountCrashReportsLabel (pinned constant when the mobile repo is absent)
//   3. the policy version/date the page shows == front matter == PRIVACY_POLICY_VERSION
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { siblingPath, mobileGate } from "./helpers/backend.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";

const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");
const html = readFileSync(join(DIST, "privacy.html"), "utf8");
const md = readFileSync(process.env.PRIVACY_MD ?? join(ROOT, "src/content/legal/uk/privacy.md"), "utf8");
const text = html.replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const SWITCH = "Надсилати звіти про збої";
const SENTRY = "Functional Software, Inc.";
/** Text between a bold lead-in and the next one at the same level. */
const part = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
const crash = part(md, "**Звіти про збої.**", "**Чого ми не збираємо");
const bullet = (label) => crash.split("\n").find((l) => l.startsWith(`- **${label}`)) ?? "";
const h2 = (n) => md.split(/\n(?=## )/).find((s) => s.startsWith(`## ${n}. `)) ?? "";

describe("/privacy: the crash-report disclosure is on the built page", () => {
  test("§2 has the «Звіти про збої» block saying it is the Android app and the server, not the website", () => {
    assert.ok(text.includes("збої в застосунку Beautica для Android потрапляють до Sentry"));
    assert.ok(text.includes("Сайт beautica.app звітів про збої не надсилає"));
  });
  test("§2 lists what is NOT sent (name, phone, email, notes, photos, screenshots, IP)", () => {
    const no = bullet("Що не надсилається");
    for (const w of ["ім'я", "номер телефону", "електронна пошта", "нотатки", "фотографії", "знімки екрана", "збереження IP вимкнено"]) assert.ok(no.includes(w), `«${w}» missing from the not-sent list`);
    assert.ok(text.includes("Що не надсилається:"));
  });
  test("§2 calls the data pseudonymous, not anonymous", () => {
    assert.match(bullet("Не повністю анонімно"), /псевдонімн/);
    assert.ok(text.includes("псевдонімними, а не анонімними"));
  });
  test("§2 recipient is Sentry (Functional Software, Inc.), EU Frankfurt", () => {
    const r = bullet("Одержувач");
    assert.ok(r.includes(`Sentry (${SENTRY})`) && r.includes("Франкфурт"));
  });
  test("§2 retention bullet says 30 днів", () => assert.match(bullet("Скільки зберігаємо"), /\*\*Скільки зберігаємо:\*\* 30 днів/));
  test("§6 lists Sentry with the company name, de.sentry.io, the app and 30 днів", () => {
    const line = h2(6).split("\n").find((l) => l.startsWith("- **Sentry**")) ?? "";
    for (const w of [SENTRY, "de.sentry.io", "застосунку для Android", "30 днів"]) assert.ok(line.includes(w), `§6 Sentry line lost «${w}»`);
    assert.ok(text.includes(`Sentry (${SENTRY}) — звіти про помилки на сервері та про збої`));
  });
  test("§7 names the DPF as the mechanism and the SCC (2021/914) as the fallback for Sentry", () => {
    const p = h2(7).split("\n").find((l) => l.startsWith("**Sentry.**")) ?? "";
    for (const w of [SENTRY, "Data Privacy Framework", "стандартні договірні положення", "2021/914"]) assert.ok(p.includes(w), `§7 Sentry paragraph lost «${w}»`);
    assert.ok(text.includes("резервний механізм передачі"));
  });
  test("§8 retention row covers the app's crash reports: 30 днів", () => {
    const row = h2(8).split("\n").find((l) => l.includes("(Sentry)")) ?? "";
    assert.match(row, /про збої в застосунку \(Sentry\)\*\* — 30 днів/);
    assert.ok(text.includes("про збої в застосунку (Sentry) — 30 днів"));
  });
  test("the old «not sending crash reports» sentence and the add-when-live marker are gone", () => {
    assert.ok(!text.includes("поки що не надсилає звітів про збої"));
    assert.ok(!md.includes("add when live: in-app crash reports"));
  });
});

describe("the opt-out switch label is one string across the policy and the app", () => {
  test("the policy quotes «" + SWITCH + "» and names the path menu → «Акаунт»", () => {
    const how = bullet("Як вимкнути");
    assert.ok(how.includes(`«${SWITCH}»`) && how.includes("«Акаунт»"));
    assert.ok(text.includes(`«${SWITCH}»`));
  });
  const arb = siblingPath("../beautica-mobile/lib/l10n/app_uk.arb");
  test("mobile ARB accountCrashReportsLabel", { skip: !mobileGate(arb) && "beautica-mobile not checked out: label pinned above" }, () => {
    assert.equal(JSON.parse(readFileSync(arb, "utf8")).accountCrashReportsLabel, SWITCH);
  });
});

describe("the policy version is one value", () => {
  test("front matter is 1.8 and its date equals PRIVACY_POLICY_VERSION", () => {
    assert.equal(/^version: "([^"]+)"/m.exec(md)[1], "1.8");
    assert.equal(/^updated: (\S+)/m.exec(md)[1], PRIVACY_POLICY_VERSION);
  });
  test("the page shows version 1.8", () => assert.match(text, /Версія 1\.8/));
});
