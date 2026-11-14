// Owner self-delete wording (SUP-67 docs/specs/support-legal.md, SAL-47 docs/specs/salon.md): privacy 1.9, terms 1.2, delete-account 1.1.
// Reads dist/client + the legal sources only: no server, no browser, no network (runs in `npm run test:static` and `npm test`).
//   1. each of /privacy, /terms, /delete-account tells the owner: delete every salon first, then «Видалити акаунт» appears on the same page
//   2. the old «owner cannot delete in the app / request by e-mail» wording is gone from the built pages and the sources
//   3. the page versions and the PRIVACY_POLICY_VERSION pin are the ones this change ships
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { OWNER_COPY } from "./fixtures/legal-owner-copy.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";

const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");
const PAGES = ["privacy", "terms", "delete-account"];
const text = (p) =>
  readFileSync(join(DIST, `${p}.html`), "utf8")
    .replace(/<(style|script)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/’/g, "'") // the build typesets the apostrophe as U+2019; the fixture quotes the source
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const src = (p) => readFileSync(join(ROOT, "src/content/legal/uk", `${p}.md`), "utf8");

describe("owner in-app account deletion is described on all three legal pages (exact copy from tests/fixtures/legal-owner-copy.mjs)", () => {
  for (const [p, phrases] of Object.entries(OWNER_COPY))
    for (const [i, phrase] of phrases.entries()) {
      test(`/${p}: built page contains owner phrase ${i + 1}`, () => assert.ok(text(p).includes(phrase), phrase.slice(0, 60)));
      test(`${p}.md: source contains owner phrase ${i + 1}`, () => assert.ok(src(p).includes(phrase), phrase.slice(0, 60)));
    }
});

describe("the old «owner cannot delete the account in the app» text is gone", () => {
  const OLD = [/через застосунок видалити акаунт не можна/, /у застосунку акаунт видалити не можна/, /Власник салону видаляє акаунт запитом на/, /є лише «Видалити салон»/];
  for (const p of PAGES)
    test(`/${p}: no old wording in the built page or the source`, () => {
      for (const re of OLD) {
        assert.doesNotMatch(text(p), re, `built /${p}`);
        assert.doesNotMatch(src(p), re, `${p}.md`);
      }
    });
});

describe("versions shipped with the change", () => {
  const front = (p) => ({ version: /^version: "([^"]+)"/m.exec(src(p))[1], updated: /^updated: (\S+)/m.exec(src(p))[1] });
  test("privacy 1.9, terms 1.2, delete-account 1.1, all dated 2026-11-14, PRIVACY_POLICY_VERSION 2026-11-14", () => {
    assert.deepEqual(front("privacy"), { version: "1.9", updated: "2026-11-14" });
    assert.deepEqual(front("terms"), { version: "1.2", updated: "2026-11-14" });
    assert.deepEqual(front("delete-account"), { version: "1.1", updated: "2026-11-14" });
    assert.equal(PRIVACY_POLICY_VERSION, "2026-11-14");
  });
  test("the built pages show those versions", () => {
    assert.match(text("privacy"), /Версія 1\.9/);
    assert.match(text("terms"), /Версія 1\.2/);
    assert.match(text("delete-account"), /Версія 1\.1/);
  });
});
