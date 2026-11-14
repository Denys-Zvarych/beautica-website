// Space-only «Nunito Fallback» faces (src/styles/fonts.css): they removed the /terms CLS (0.0075 -> 0) caused by Arial's word space (0.278 em)
// being wider than Nunito's (0.258 regular / 0.271 bold) while the Cyrillic file was already swapped in and the Latin one (the space) was not.
//   1. static: two faces for U+0020,U+00A0 only (regular + 700), local() Arial sources, size-adjust matching Nunito's space / Arial's 0.278
//   2. browser: the real Nunito file's space advance (measured by Chromium, variable font at 400 and 700) matches those size-adjust values
//   3. lighthouserc keeps /terms under the 0.005 CLS cap
// No server, no network: only the font file in node_modules and a data-less about:blank page.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/env.mjs";
import { launch } from "./helpers/browser.mjs";

const css = readFileSync(join(ROOT, "src/styles/fonts.css"), "utf8");
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
const prop = (body, k) => new RegExp(`${k}:\\s*([^;]+);`).exec(body)?.[1].trim();
const spaceFaces = faces.filter((f) => /font-family:\s*"Nunito Fallback"/.test(f) && prop(f, "unicode-range") === "U+0020,U+00A0");
const ARIAL_SPACE = 0.278; // Arial / Liberation Sans / Arimo advance of U+0020, regular and bold (metric-identical)
const pct = (f) => parseFloat(prop(f, "size-adjust"));
const regular = spaceFaces.find((f) => !prop(f, "font-weight"));
const bold = spaceFaces.find((f) => prop(f, "font-weight") === "700");

describe("fonts.css: space-only Nunito fallback faces", () => {
  test("there are exactly two: a regular and a 700 one, both for U+0020,U+00A0 only", () => {
    assert.equal(spaceFaces.length, 2);
    assert.ok(regular && bold);
  });
  test("they use local Arial-compatible fonts only (no download) and keep the other overrides", () => {
    assert.match(prop(regular, "src"), /^local\("Arial"\), local\("Liberation Sans"\), local\("Arimo"\)$/);
    assert.match(prop(bold, "src"), /^local\("Arial Bold"\), local\("Liberation Sans Bold"\), local\("Arimo Bold"\)$/);
    for (const f of spaceFaces) assert.equal(prop(f, "line-gap-override"), "0%");
  });
  test("size-adjust is 92.86% (regular) and 97.54% (bold)", () => {
    assert.equal(pct(regular), 92.86);
    assert.equal(pct(bold), 97.54);
  });
  test("the full-range «Nunito Fallback» faces (whole alphabet) still exist, so only the space is rescaled", () => {
    const full = faces.filter((f) => /font-family:\s*"Nunito Fallback"/.test(f) && !prop(f, "unicode-range"));
    assert.ok(full.length >= 1);
  });
  test("tokens.css still puts «Nunito Fallback» right after Nunito in the body stack", () => {
    assert.match(readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8"), /--vt-font-body: "Nunito", "Nunito Fallback"/);
  });
});

describe("lighthouserc: /terms is held to the CLS cap", () => {
  test("terms.html is collected and asserted with cumulative-layout-shift <= 0.005", () => {
    const lh = JSON.parse(readFileSync(join(ROOT, "lighthouserc.json"), "utf8")).ci;
    assert.ok(lh.collect.url.includes("http://localhost/terms.html"));
    const m = lh.assert.assertMatrix.find((x) => new RegExp(x.matchingUrlPattern).test("http://localhost/terms.html"));
    assert.ok(m, "an assertMatrix entry matches /terms.html");
    assert.deepEqual(m.assertions["cumulative-layout-shift"], ["error", { maxNumericValue: 0.005 }]);
  });
});

describe("the size-adjust values equal Nunito's real space advance / Arial's (measured in Chromium)", () => {
  let browser;
  let adv;
  before(async () => {
    browser = await launch();
    const page = await browser.newPage();
    const b64 = readFileSync(join(ROOT, "node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2")).toString("base64");
    adv = await page.evaluate(async (data) => {
      const face = new FontFace("NunitoProbe", `url(data:font/woff2;base64,${data})`, { weight: "200 1000" });
      document.fonts.add(await face.load());
      const c = document.createElement("canvas").getContext("2d");
      const w = (weight) => {
        c.font = `${weight} 1000px NunitoProbe`;
        return c.measureText(" ").width / 1000;
      };
      return { regular: w(400), bold: w(700) };
    }, b64);
    await page.close();
  });
  after(() => browser?.close());
  test("regular: Nunito 400 space / 0.278 == size-adjust within 0.3 points", () => assert.ok(Math.abs((adv.regular / ARIAL_SPACE) * 100 - pct(regular)) < 0.3, JSON.stringify(adv)));
  test("bold: Nunito 700 space / 0.278 == size-adjust within 0.3 points", () => assert.ok(Math.abs((adv.bold / ARIAL_SPACE) * 100 - pct(bold)) < 0.3, JSON.stringify(adv)));
});
