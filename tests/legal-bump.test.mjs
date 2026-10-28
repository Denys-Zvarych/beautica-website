// Phase 018 QA (legal bump: terms 1.1, privacy 1.3, PRIVACY_POLICY_VERSION 2026-10-29) and the legal-page font change (latin-basic subset).
// Reads dist/client + sources only: no server, no browser, no network (runs in the server-less `site` job via `npm run test:static`, and in `npm test`).
//   1. the version and date a visitor reads on /privacy and /terms are the ones of the Markdown front matter and of src/config/legal.mjs
//   2. docs/claims.md still resolves (script run) and the ledger row that points into our own legal text still lands on that text
//   3. the opt-out button quoted in the policy is the button the review page shows (uk.json)
//   4. the IP-forwarding sentence of the policy is true for every page it names
//   5. the fonts of the legal pages: only basic Latin + Cyrillic are requested, every visible glyph is covered, the files really hold the glyphs, the bytes stay in budget
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { join } from "node:path";
import { ROOT, uk } from "./helpers/env.mjs";
import { PRIVACY_POLICY_VERSION } from "../src/config/legal.mjs";
import { BASIC_GLYPHS, BASIC_RANGE } from "../scripts/subset-fonts.mjs";

const DIST = join(ROOT, "dist", "client");
assert.ok(existsSync(DIST), "dist/client is missing: run `npm run build` first");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const page = (p) => readFileSync(join(DIST, `${p}.html`), "utf8");
const front = (md) => ({ version: /^version: "([^"]+)"/m.exec(md)[1], updated: /^updated: (\S+)/m.exec(md)[1] });
const privacyMd = read("src/content/legal/uk/privacy.md");
const termsMd = read("src/content/legal/uk/terms.md");
const KB = 1024;

/** What LegalPage.astro prints: «Версія X» and «<label>: <time datetime>d month yyyy</time>». */
const shownDate = (iso) => new Date(iso).toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** The meta line of LegalPage as built (Astro adds data-astro-cid-* attributes to every element). */
const shown = (version, iso) => new RegExp(`<span[^>]*>${uk.legal.version.replace("{version}", version).replace(/\./g, "\\.")}</span><span[^>]*>[^<]*<time datetime="${iso}"[^>]*>${shownDate(iso).replace(/\./g, "\\.")}</time>`);
const visibleText = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ");

describe("the version and the date shown on the legal pages come from the sources of truth", () => {
  test("/privacy shows the privacy.md version and date, and that date is PRIVACY_POLICY_VERSION (what every guest consent records)", () => {
    const { version, updated } = front(privacyMd);
    const html = page("privacy");
    assert.equal(updated, PRIVACY_POLICY_VERSION, "privacy.md `updated:` and legal.mjs PRIVACY_POLICY_VERSION must be bumped together");
    assert.match(html, shown(version, updated), `/privacy does not show «Версія ${version}» / ${updated} (${shownDate(updated)})`);
  });
  test("/terms shows the terms.md version and date", () => {
    const { version, updated } = front(termsMd);
    const html = page("terms");
    assert.match(html, shown(version, updated), `/terms does not show «Версія ${version}» / ${updated} (${shownDate(updated)})`);
  });
  test("the bump is the one the phase doc ships: terms 1.1, privacy 1.3, 2026-10-29 on both (the backend gate compares this version string)", () => {
    assert.deepEqual(front(privacyMd), { version: "1.3", updated: "2026-10-29" });
    assert.deepEqual(front(termsMd), { version: "1.1", updated: "2026-10-29" });
    assert.equal(PRIVACY_POLICY_VERSION, "2026-10-29");
  });
});

describe("docs/claims.md after the bump", () => {
  test("every row resolves (source line in range, page anchor in the build): npm run check:claims exits 0", () => {
    const r = spawnSync(process.execPath, ["scripts/check-claims.mjs"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /, 0 broken,/);
  });
  test("a row that points into our own legal text lands on the sentence it claims (the line numbers moved with the bump)", () => {
    const ledger = read("docs/claims.md");
    const own = [...ledger.matchAll(/^\|([^|]+)\|[^|]+\|\s*`(src\/content\/legal\/uk\/([\w-]+\.md)):(\d+)`/gm)];
    assert.ok(own.length >= 1, "no ledger row points into src/content/legal: the parser is broken or the row was removed");
    const needle = { "Reply to a deletion request within 30 calendar days": "протягом 30 календарних днів" };
    for (const [, claim, file, , line] of own) {
      const key = Object.keys(needle).find((k) => claim.includes(k));
      assert.ok(key, `unpinned ledger row into ${file}:${line}: add its phrase to this test (${claim.trim().slice(0, 60)})`);
      assert.ok(read(file).split("\n")[Number(line) - 1].includes(needle[key]), `${file}:${line} no longer contains «${needle[key]}»: repoint the ledger row`);
    }
  });
  test("the claims of the bump (reports, moderation, blocks, guest review, opt-out) keep their ledger rows (a row gone = a claim nobody checks)", () => {
    const rows = read("docs/claims.md").split("\n").filter((l) => l.startsWith("|"));
    const want = {
      "Reports (terms §7, privacy §2): the report comment holds at most 500": 1,
      "Reports (terms §7): the report is anonymous": 1,
      "Moderation (terms §4): 3 different clients": 1,
      "Moderation (privacy §8): resolved reports": 1,
      "Blocks (terms §6, privacy §2): registered client": 1,
      "Guest review (terms §4, privacy §2): published name": 1,
      "Guest review invite (privacy §3): one SMS per visit": 1,
      "Guest review (privacy §3): comment up to 2000": 1,
      "Guest review opt-out (privacy §3): the button text": 1,
      "Guest review (privacy §4): the review page /r/{token} loads no analytics": 1,
    };
    for (const [prefix, n] of Object.entries(want)) assert.equal(rows.filter((r) => r.startsWith(`| ${prefix}`)).length, n, `ledger row «${prefix}…» missing`);
    for (const r of rows.filter((r) => /^\| (Reports|Moderation|Blocks|Guest review)/.test(r))) assert.match(r, /\| (live|not-live) \|$/, `row without a live/not-live status: ${r.slice(0, 70)}`);
  });
});

describe("the opt-out button quoted in the policy is the page's button", () => {
  test("privacy.md quotes «uk.review.optOut» verbatim, and /privacy renders it", () => {
    assert.equal(uk.review.optOut, "Не надсилати мені такі СМС", "the button text changed: update the policy sentence and bump the version");
    assert.ok(privacyMd.includes(`«${uk.review.optOut}»`), "privacy.md quotes a button text that is not the page's");
    assert.ok(page("privacy").includes(`«${uk.review.optOut}»`), "the built /privacy does not show the quote");
  });
});

describe("the IP-forwarding sentence of the policy is true for every page it names (master, salon, review form)", () => {
  test("privacy §3 names master, salon and review pages, and each of the three SSR pages forwards the visitor IP", () => {
    const line = privacyMd.split("\n").find((l) => l.startsWith("- **Технічні дані перегляду:**"));
    assert.ok(line, "the «Технічні дані перегляду» bullet is gone");
    assert.match(line, /сторінку майстра, салону чи відгуку за посиланням/);
    assert.match(line, /вона не потрапляє в запис/);
    for (const [what, file] of [["master", "src/pages/book/[slug].astro"], ["salon", "src/pages/book/s/[slug].astro"], ["review form", "src/pages/r/[token].astro"]]) {
      const src = read(file);
      assert.match(src, /headers\.get\("cf-connecting-ip"\)/, `${what} page does not read the visitor IP`);
      assert.match(src, /\bip\b[^\n]*\)|\{[^}]*\bip\b[^}]*\}|, ip\b/, `${what} page reads the IP but does not hand it on`);
    }
  });
  test("report privacy: the policy says the author is not told who reported and the team message has no comment", () => {
    const line = privacyMd.split("\n").find((l) => l.startsWith("**Скарги на контент.**"));
    assert.ok(line, "the «Скарги на контент» paragraph is gone");
    assert.match(line, /Автору контенту ми не повідомляємо, хто поскаржився/);
    assert.match(line, /без вашого коментаря та тексту відгуку/);
  });
});

describe("legal-page fonts: basic Latin + Cyrillic only", () => {
  const LEGAL = ["privacy", "terms", "support", "delete-account"];
  const expand = (r) => new Set(r.split(",").flatMap((p) => { const [a, b = a] = p.slice(2).split("-").map((h) => parseInt(h, 16)); return Array.from({ length: b - a + 1 }, (_, i) => a + i); }));
  const cyrillic = expand(/nunito-cyrillic[\s\S]*?unicode-range: ([^;]+);/.exec(read("src/styles/fonts.css"))[1]);
  const covered = new Set([...expand(BASIC_RANGE), ...cyrillic, 0x20b4]); // + the hryvnia face of fonts.css (always loaded, 1.3 KB)

  /** The code points of a (variable) woff2: brotli stream -> cmap table -> format 4 / 12 subtables. */
  function woff2Cmap(buf) {
    assert.equal(buf.toString("latin1", 0, 4), "wOF2");
    const n = buf.readUInt16BE(12);
    let o = 48;
    const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[o++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error("bad UIntBase128"); };
    const dir = [];
    for (let i = 0; i < n; i++) {
      const flags = buf[o++];
      const tag = (flags & 0x3f) === 0x3f ? (o += 4, buf.toString("latin1", o - 4, o)) : flags & 0x3f; // 0 = cmap, 3 = hmtx, 10 = glyf, 11 = loca in the known-tag table
      const orig = base128();
      const ver = flags >> 6;
      const transformed = tag === 10 || tag === 11 ? ver === 0 : tag === 3 ? ver === 1 : false;
      dir.push({ tag, len: transformed ? base128() : orig });
    }
    const compressed = buf.subarray(o, o + buf.readUInt32BE(20));
    const data = brotliDecompressSync(compressed);
    const at = dir.findIndex((d) => d.tag === 0 || d.tag === "cmap");
    assert.ok(at >= 0, "no cmap table");
    const cmap = data.subarray(dir.slice(0, at).reduce((s, d) => s + d.len, 0));
    const cps = new Set();
    for (let i = 0; i < cmap.readUInt16BE(2); i++) {
      const sub = cmap.subarray(cmap.readUInt32BE(4 + i * 8 + 4));
      const fmt = sub.readUInt16BE(0);
      if (fmt === 4) {
        const seg = sub.readUInt16BE(6) / 2;
        for (let s = 0; s < seg; s++) {
          const end = sub.readUInt16BE(14 + s * 2), start = sub.readUInt16BE(16 + seg * 2 + s * 2);
          for (let c = start; c <= Math.min(end, 0xfffe); c++) cps.add(c);
        }
      } else if (fmt === 12) {
        for (let g = 0; g < sub.readUInt32BE(12); g++) { const e = 16 + g * 12; for (let c = sub.readUInt32BE(e); c <= sub.readUInt32BE(e + 4); c++) cps.add(c); }
      }
    }
    return cps;
  }

  test("the built CSS of a legal page declares the basic face AFTER the full Latin face (the later rule wins); other pages never declare it", () => {
    for (const p of LEGAL) {
      const html = page(p);
      for (const fam of ["nunito", "comfortaa"]) {
        const full = html.search(new RegExp(`url\\(/_astro/${fam}-latin-wght-normal`));
        const basic = html.search(new RegExp(`url\\(/_astro/${fam}-latin-basic-wght-normal`));
        assert.ok(basic > 0, `/${p}: no ${fam} latin-basic @font-face in the inlined CSS`);
        assert.ok(full > 0 && basic > full, `/${p}: ${fam} basic face (${basic}) must come after the full face (${full})`);
      }
    }
    assert.doesNotMatch(page("index"), /latin-basic/, "the home page must not carry the legal subset");
  });

  const fullLatin = expand(/nunito-latin-wght[\s\S]*?unicode-range: ([^;]+);/.exec(read("src/styles/fonts.css"))[1]);

  test("every character a legal page shows that the FULL Latin face covers is also in the basic subset or Cyrillic (otherwise the browser fetches the 70 KB Latin face on top)", () => {
    for (const p of LEGAL) {
      const text = visibleText(page(p)).replace(/&nbsp;/g, "\u00a0");
      const lost = [...new Set([...text].filter((ch) => { const c = ch.codePointAt(0); return fullLatin.has(c) && !covered.has(c) && !/\s/.test(ch); }))].map((ch) => `${ch} U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
      assert.deepEqual(lost, [], `/${p} shows glyphs only the full Latin face has: ${lost.join(", ")}`);
    }
  });

  test("the two basic woff2 files really contain every glyph of BASIC_GLYPHS that the source Latin face has (the unicode-range promises it)", () => {
    for (const fam of ["nunito", "comfortaa"]) {
      const cps = woff2Cmap(readFileSync(join(ROOT, "src", "fonts", `${fam}-latin-basic-wght-normal.woff2`)));
      const source = woff2Cmap(readFileSync(join(ROOT, "node_modules/@fontsource-variable", fam, "files", `${fam}-latin-wght-normal.woff2`)));
      const missing = BASIC_GLYPHS.filter((c) => source.has(c) && !cps.has(c)).map((c) => "U+" + c.toString(16).toUpperCase());
      assert.deepEqual(missing, [], `${fam}-latin-basic lacks glyphs the CSS range claims: ${missing.join(",")}`);
      for (const c of [..."AZaz09@:/-"].map((x) => x.codePointAt(0))) assert.ok(cps.has(c), `${fam}-latin-basic lacks ${String.fromCodePoint(c)}`);
    }
  });

  test("bytes: each legal page preloads exactly 2 Cyrillic + 2 basic files, no more, and the four files stay <= 90 KB (budget 110, headroom >= 20)", () => {
    for (const p of LEGAL) {
      const hrefs = [...page(p).matchAll(/<link rel="preload" as="font"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(hrefs.length, 4, `/${p} preloads ${hrefs.length} fonts: ${hrefs}`);
      const bytes = hrefs.reduce((s, h) => s + statSync(join(DIST, h)).size, 0);
      assert.ok(bytes <= 90 * KB, `/${p} preloads ${bytes} B of fonts (> 90 KB): the basic subset is no longer small`);
    }
  });
});
