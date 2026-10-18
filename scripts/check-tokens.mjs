#!/usr/bin/env node
// Token parity check: src/styles/tokens.css  <->  beautica-mobile theme (Dart). Zero dependencies.
//
//   node scripts/check-tokens.mjs [--mobile ../beautica-mobile]
//
// Exit codes: 0 ok, 1 parity/annotation failure, 2 mobile repo not found (CI: skip only on 2).
//
// What it enforces
//   1. every `--vt-*` declaration in tokens.css has `/* @src Dart.Symbol */` OR is in the web-only allow-list
//   2. every @src resolves in lib/core/theme/{brand_colors,velvet_geometry,velvet_text}.dart (no dangling @src)
//   3. the CSS value equals the value computed from the Dart source (colour, px, shadow list, gradient, text style)
//   4. components/pages/base.css contain no raw colour or px value (only var(--vt-*)); `@media (min-width)`
//      values must equal a --vt-bp-* token (custom properties cannot be used inside @media)
//
// Supported Dart shapes (extend here when the theme grows a new shape; unsupported = loud failure, never skipped):
//   static const Color x = Color(0xAARRGGBB);
//   static const double x = 12;
//   static const|final List<BoxShadow> x = <BoxShadow>[ BoxShadow(color:, offset: Offset(a,b), blurRadius:) ];
//   static const|final LinearGradient x = LinearGradient(begin: topLeft, end: bottomRight, colors: [A, B]);
//   static final TextStyle _x = GoogleFonts.family(fontSize:, fontWeight:, letterSpacing:, height:, color:);
//   `.withValues(alpha: n)` on a colour.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argIdx = process.argv.indexOf("--mobile");
const MOBILE = resolve(ROOT, argIdx > -1 ? process.argv[argIdx + 1] : "../beautica-mobile");
const THEME = join(MOBILE, "lib/core/theme");
const DART_FILES = ["brand_colors.dart", "velvet_geometry.dart", "velvet_text.dart"];

/** Web-only tokens with no Dart source (README D3 allow-list). */
const ALLOW = [
  /^--vt-fs-prose$/,
  /^--vt-fw-prose$/,
  /^--vt-lh-prose$/,
  /^--vt-fs-display$/,
  /^--vt-bp-[a-z]+$/,
  /^--vt-max-width$/,
  /^--vt-touch-min$/,
];

const errors = [];
const fail = (msg) => errors.push(msg);

if (!existsSync(THEME)) {
  console.error(`check-tokens: mobile theme not found at ${THEME} (use --mobile <path>)`);
  process.exit(2);
}

// ---------------------------------------------------------------- Dart parsing
const dart = DART_FILES.map((f) => readFileSync(join(THEME, f), "utf8")).join("\n");
const noComments = dart.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Text between the paren/bracket opening at `openIdx` and its match. */
function balanced(text, openIdx) {
  const open = text[openIdx];
  const close = { "(": ")", "[": "]", "{": "}" }[open];
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(openIdx + 1, i);
  }
  throw new Error("unbalanced " + open);
}

/** Split on top-level commas. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{<".includes(ch)) depth++;
    if (")]}>".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Classes: { name -> body text }. */
const classes = {};
{
  const re = /abstract final class (\w+)\s*\{/g;
  const starts = [];
  let m;
  while ((m = re.exec(noComments))) starts.push({ name: m[1], at: m.index, bodyAt: re.lastIndex - 1 });
  for (const s of starts) classes[s.name] = balanced(noComments, s.bodyAt);
}

const num = (n) => String(Math.round(parseFloat(n) * 10000) / 10000);

function evalNumber(expr) {
  const e = expr.trim();
  if (!/^[\d\s.*+/()-]+$/.test(e)) throw new Error(`unsupported number expression "${e}"`);
  return Function(`"use strict"; return (${e});`)();
}

/** Resolve a Dart colour expression to a CSS colour. */
function resolveColor(expr) {
  const e = expr.trim();
  let m = e.match(/^(.+?)\.withValues\(\s*alpha:\s*([\d.]+)\s*\)$/s);
  if (m) {
    const [r, g, b] = rgbOf(resolveColor(m[1]));
    return `rgba(${r}, ${g}, ${b}, ${num(m[2])})`;
  }
  m = e.match(/^(?:const\s+)?Color\(\s*0x([0-9A-Fa-f]{8})\s*\)$/);
  if (m) {
    const a = parseInt(m[1].slice(0, 2), 16);
    const hex = "#" + m[1].slice(2).toUpperCase();
    if (a === 255) return hex;
    const [r, g, b] = rgbOf(hex);
    return `rgba(${r}, ${g}, ${b}, ${num(a / 255)})`;
  }
  m = e.match(/^(\w+)\.(\w+)$/);
  if (m) return resolveSymbol(m[1], m[2]);
  throw new Error(`unsupported colour expression "${e}"`);
}
const rgbOf = (css) => {
  const h = css.match(/^#([0-9A-F]{6})$/);
  if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16));
  throw new Error(`cannot take rgb of ${css}`);
};

function findDecl(cls, name) {
  const body = classes[cls];
  if (body === undefined) throw new Error(`class ${cls} not found in theme files`);
  const re = new RegExp(`static\\s+(?:const|final)\\s+([\\w<>]+)\\s+${name}\\s*=\\s*`);
  const m = re.exec(body);
  if (!m) throw new Error(`${cls}.${name} not found`);
  return { type: m[1], rest: body.slice(m.index + m[0].length) };
}

/** Resolve `Class.member` or `Class._style.prop` to the expected CSS value string. */
function resolveSymbol(cls, member, prop) {
  const { type, rest } = findDecl(cls, member);
  const stmt = rest.slice(0, rest.indexOf(";")); // enough for scalars/colours
  if (prop) {
    if (type !== "TextStyle") throw new Error(`${cls}.${member}.${prop}: not a TextStyle`);
    return resolveTextProp(rest, prop);
  }
  switch (type) {
    case "Color":
      return resolveColor(stmt);
    case "double":
      return num(evalNumber(stmt)) + "px";
    case "List<BoxShadow>":
      return resolveShadows(rest);
    case "LinearGradient":
      return resolveGradient(rest);
    default:
      throw new Error(`${cls}.${member}: unsupported type ${type}`);
  }
}

function resolveShadows(rest) {
  const list = balanced(rest, rest.indexOf("["));
  const items = [];
  const re = /BoxShadow\(/g;
  while (re.exec(list)) {
    const args = splitTop(balanced(list, re.lastIndex - 1));
    const get = (k) => args.find((a) => a.startsWith(k + ":"))?.slice(k.length + 1).trim();
    const color = resolveColor(get("color"));
    const off = get("offset");
    const [dx, dy] = off ? splitTop(balanced(off, off.indexOf("("))).map((v) => num(evalNumber(v))) : ["0", "0"];
    const blur = num(evalNumber(get("blurRadius")));
    items.push(`${dx}px ${dy}px ${blur}px ${color}`);
  }
  if (!items.length) throw new Error("empty BoxShadow list");
  return items.join(", ");
}

function resolveGradient(rest) {
  const args = splitTop(balanced(rest, rest.indexOf("(")));
  const get = (k) => args.find((a) => a.startsWith(k + ":"))?.slice(k.length + 1).trim();
  if (get("begin") !== "Alignment.topLeft" || get("end") !== "Alignment.bottomRight") {
    throw new Error("only topLeft->bottomRight gradients are supported");
  }
  const colors = splitTop(balanced(get("colors"), get("colors").indexOf("["))).map(resolveColor);
  return `linear-gradient(to bottom right, ${colors.join(", ")})`;
}

function resolveTextProp(rest, prop) {
  const fm = rest.match(/^GoogleFonts\.(\w+)\(/);
  if (!fm) throw new Error("text style is not a GoogleFonts.<family>( ... ) literal");
  if (prop === "fontFamily") return fm[1][0].toUpperCase() + fm[1].slice(1);
  const args = splitTop(balanced(rest, rest.indexOf("(")));
  const raw = args.find((a) => a.startsWith(prop + ":"))?.slice(prop.length + 1).trim();
  if (raw === undefined) throw new Error(`TextStyle has no ${prop}`);
  if (prop === "fontWeight") return raw.replace("FontWeight.w", "");
  if (prop === "fontSize" || prop === "letterSpacing") return num(evalNumber(raw)) + "px";
  if (prop === "height") return num(evalNumber(raw));
  if (prop === "color") return resolveColor(raw);
  throw new Error(`unsupported text prop ${prop}`);
}

function expectedFor(src) {
  const parts = src.split(".");
  if (parts.length === 2) return resolveSymbol(parts[0], parts[1]);
  if (parts.length === 3) return resolveSymbol(parts[0], parts[1], parts[2]);
  throw new Error(`bad @src "${src}"`);
}

// ---------------------------------------------------------------- comparison
const canon = (s) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(\d)px/g, "$1")
    .replace(/-?\d*\.?\d+/g, (n) => String(parseFloat(n)))
    .trim();

function cssValueMatches(css, expected, src) {
  if (src.endsWith(".fontFamily")) {
    const first = css.split(",")[0].trim().replace(/^["']|["']$/g, "");
    return first === expected;
  }
  return canon(css) === canon(expected);
}

// ---------------------------------------------------------------- tokens.css
const tokensPath = join(ROOT, "src/styles/tokens.css");
const tokensCss = readFileSync(tokensPath, "utf8");
const declRe = /^\s*(--vt-[\w-]+)\s*:\s*(.+?);\s*(?:\/\*\s*@src\s+([\w.]+)\s*\*\/)?\s*$/;
let checked = 0;
let allowed = 0;
const seen = new Set();

tokensCss.split("\n").forEach((line, i) => {
  if (!/^\s*--vt-/.test(line)) return;
  const at = `tokens.css:${i + 1}`;
  const m = line.match(declRe);
  if (!m) return fail(`${at}: cannot parse declaration (one declaration per line): ${line.trim()}`);
  const [, name, value, src] = m;
  if (/^--vt-bp-/.test(name) || !seen.has(name)) seen.add(name);
  if (!src) {
    if (ALLOW.some((re) => re.test(name))) return void allowed++;
    return fail(`${at}: ${name} has no @src and is not in the web-only allow-list`);
  }
  let expected;
  try {
    expected = expectedFor(src);
  } catch (e) {
    return fail(`${at}: ${name} dangling @src ${src} (${e.message})`);
  }
  checked++;
  if (!cssValueMatches(value, expected, src)) {
    fail(`${at}: ${name} = "${value}" but ${src} = "${expected}"`);
  }
});

// ---------------------------------------------------------------- raw values elsewhere
const bps = [...tokensCss.matchAll(/--vt-bp-[\w-]+\s*:\s*(\d+)px/g)].map((m) => Number(m[1]));
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const scanned = walk(join(ROOT, "src")).filter(
  (p) => /\.(css|astro)$/.test(p) && !p.endsWith("styles/tokens.css") && !p.endsWith("styles/fonts.css"),
);
for (const file of scanned) {
  const rel = file.slice(ROOT.length + 1);
  const text = readFileSync(file, "utf8");
  // only <style> blocks and plain .css files; Astro frontmatter/markup is not styling
  const styleText = file.endsWith(".css") ? text : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  if (!styleText) continue;
  const offset = file.endsWith(".css") ? 0 : text.slice(0, text.indexOf(styleText)).split("\n").length - 1;
  styleText.split("\n").forEach((rawLine, i) => {
    const line = rawLine.replace(/\/\*.*?\*\//g, "");
    const at = `${rel}:${i + 1 + offset}`;
    const mq = line.match(/@media[^{]*\(\s*(min|max)-width\s*:\s*(\d+)px\s*\)/);
    if (mq) {
      if (mq[1] === "max") fail(`${at}: max-width media query (mobile-first: use min-width)`);
      else if (!bps.includes(Number(mq[2]))) fail(`${at}: breakpoint ${mq[2]}px is not a --vt-bp-* token`);
      return;
    }
    if (/#[0-9a-fA-F]{3,8}\b/.test(line)) fail(`${at}: raw colour (use a --vt-color-* token): ${line.trim()}`);
    if (/rgba?\(|hsla?\(/.test(line)) fail(`${at}: raw colour function (use a token): ${line.trim()}`);
    if (/(?<![\w.-])-?[1-9]\d*(\.\d+)?px\b/.test(line)) fail(`${at}: raw px value (use a --vt-* token): ${line.trim()}`);
  });
}

// ---------------------------------------------------------------- result
if (errors.length) {
  console.error(`check-tokens: FAIL (${errors.length})`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(
  `check-tokens: OK — ${checked} tokens match the Dart source, ${allowed} web-only allow-listed, ${scanned.length} style files scanned`,
);
