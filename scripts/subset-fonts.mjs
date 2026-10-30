#!/usr/bin/env node
// Regenerates the font subsets in src/fonts/ from the @fontsource-variable files (run after a fontsource upgrade or a change of the lists below):
//   latin-core  src/fonts/{nunito,comfortaa}-latin-core-wght-normal.woff2   (declared in src/styles/book.css)
//   latin-basic src/fonts/{nunito,comfortaa}-latin-basic-wght-normal.woff2  (declared in src/styles/fonts-legal.css; the legal pages: core + A-Z a-z + ©)
//   hryvnia     src/fonts/{nunito,comfortaa}-hryvnia-wght-normal.woff2      (declared in src/styles/fonts.css; U+20B4 only)
//
// Needs fontTools + brotli for python3. Local install without touching system packages (no venv/pip needed):
//   curl -sSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py
//   python3 /tmp/get-pip.py --target ~/.cache/ft && PYTHONPATH=~/.cache/ft python3 -m pip install --target ~/.cache/ft fonttools brotli
//   FONTTOOLS_PYTHONPATH=~/.cache/ft node scripts/subset-fonts.mjs        (or `pip install fonttools brotli` into any python3 on PATH)
//
// THE unicode lists live here, in one place; the comments in fonts.css / book.css point to this file. The core's `unicode-range` in book.css
// must equal CORE_RANGE below (display glyphs + control characters), and the full Latin face keeps everything else (see fonts.css).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const u = (cps) => cps.map((c) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`).join(",");

/** Glyphs the core DISPLAYS: space, digits, punctuation, no-break space, « », · , en/em dash, quotes, bullet, ellipsis. */
export const CORE_GLYPHS = [...range(0x20, 0x40), ...range(0x5b, 0x60), ...range(0x7b, 0x7e), 0xa0, 0xab, 0xb7, 0xbb, 0x2013, 0x2014, ...range(0x2018, 0x201e), 0x2022, 0x2026];
/** Control characters: no glyph, but listed in the core's unicode-range so a line break (U+000A) never pulls the big Latin file. */
export const CORE_CONTROLS = [...range(0, 0x1f), ...range(0x7f, 0x9f)];
/** Never displayed from the core (its unicode-range excludes letters), but present in the file: FreeType's autohinter takes its alignment
 *  zones from these letters, and without them Chrome on Linux renders digits and punctuation a pixel differently from the full face. */
export const HINT_LETTERS = [..."THEZOCQSLUfijkdbhxrescpqgyz"].map((c) => c.codePointAt(0)).sort((a, b) => a - b);
/** What book.css must declare as the core's unicode-range (CSS shorthand of CORE_GLYPHS + CORE_CONTROLS). */
export const CORE_RANGE = "U+0000-0040,U+005B-0060,U+007B-00A0,U+00AB,U+00B7,U+00BB,U+2013-2014,U+2018-201E,U+2022,U+2026";

/** Legal pages (/privacy, /terms, /support, /delete-account): Ukrainian prose with Latin brand names, e-mails, URLs, SMS, and the © of the footer. */
export const BASIC_GLYPHS = [...range(0x20, 0x7e), 0xa0, 0xa9, 0xab, 0xb7, 0xbb, 0x2013, 0x2014, ...range(0x2018, 0x201e), 0x2022, 0x2026];
/** What fonts-legal.css must declare as the basic face's unicode-range (BASIC_GLYPHS + the same control characters as the core). */
export const BASIC_RANGE = "U+0000-00A0,U+00A9,U+00AB,U+00B7,U+00BB,U+2013-2014,U+2018-201E,U+2022,U+2026";

// The shorthand and the lists must agree (the script fails otherwise, so book.css cannot drift from what the file really contains).
const expand = (r) => r.split(",").flatMap((p) => { const [a, b = a] = p.slice(2).split("-").map((h) => parseInt(h, 16)); return range(a, b); });
const want = [...new Set([...CORE_GLYPHS, ...CORE_CONTROLS])].sort((a, b) => a - b).join();
if (expand(CORE_RANGE).sort((a, b) => a - b).join() !== want) throw new Error("subset-fonts: CORE_RANGE does not match CORE_GLYPHS + CORE_CONTROLS");

const wantBasic = [...new Set([...BASIC_GLYPHS, ...CORE_CONTROLS])].sort((a, b) => a - b).join();
if (expand(BASIC_RANGE).sort((a, b) => a - b).join() !== wantBasic) throw new Error("subset-fonts: BASIC_RANGE does not match BASIC_GLYPHS + CORE_CONTROLS");

const FAMILIES = ["nunito", "comfortaa"];
const SRC = (family, subset) => join(ROOT, "node_modules/@fontsource-variable", family, "files", `${family}-${subset}-wght-normal.woff2`);
const env = { ...process.env, ...(process.env.FONTTOOLS_PYTHONPATH ? { PYTHONPATH: process.env.FONTTOOLS_PYTHONPATH } : {}) };

function subset(input, output, unicodes, features) {
  const r = spawnSync("python3", ["-m", "fontTools.subset", input, `--unicodes=${unicodes}`, "--flavor=woff2", `--layout-features=${features}`, `--output-file=${output}`], { env, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    console.error("subset-fonts: python3 -m fontTools.subset failed (see the install note at the top of this file)");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of FAMILIES) {
    subset(SRC(f, "latin"), join(ROOT, "src/fonts", `${f}-latin-core-wght-normal.woff2`), u([...CORE_GLYPHS, ...HINT_LETTERS]), "*");
    subset(SRC(f, "latin"), join(ROOT, "src/fonts", `${f}-latin-basic-wght-normal.woff2`), u(BASIC_GLYPHS), "*");
    subset(SRC(f, "cyrillic-ext"), join(ROOT, "src/fonts", `${f}-hryvnia-wght-normal.woff2`), "U+20B4", "");
  }
  console.log("subset-fonts: wrote 6 files to src/fonts/");
}
