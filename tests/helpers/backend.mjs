// Reads the backend's source (sibling repo) so tests can compare the site against the real DTOs and constants.
// Where the repo lives: BACKEND_DIR (CI checks it out into ./beautica-backend), else ../beautica-backend. Absent = the specs skip,
// unless REQUIRE_BACKEND=1 (CI after a successful checkout), which turns "absent" into a failure so a gate can never silently go inert.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./env.mjs";

export const BACKEND_DIR = resolve(ROOT, process.env.BACKEND_DIR ?? "../beautica-backend");
const JAVA = join(BACKEND_DIR, "src/main/java/com/beautica");
export const backendPresent = existsSync(JAVA);
export const REQUIRE_BACKEND = process.env.REQUIRE_BACKEND === "1";
/** `{ skip }` option for node:test: skip when the backend is absent and not required. Throws when required but absent. */
export function backendGate() {
  if (REQUIRE_BACKEND && !backendPresent) throw new Error(`REQUIRE_BACKEND=1 but ${JAVA} is missing`);
  return { skip: backendPresent ? false : "backend sources not available (sibling repo absent)" };
}

let index;
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".java")) out.push(p);
  }
  return out;
}
/** Java source of a top-level type by its simple name (UserDto.java -> "UserDto"). */
export function javaSource(typeName) {
  index ??= new Map(walk(JAVA).map((p) => [p.replace(/^.*\//, "").replace(/\.java$/, ""), p]));
  const p = index.get(typeName);
  if (!p) throw new Error(`backend type ${typeName} not found under ${JAVA}`);
  return readFileSync(p, "utf8");
}

/** Removes comments (keeping string literals intact). */
function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    if (src[i] === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (src.startsWith("//", i)) i = src.indexOf("\n", i);
    else if (src.startsWith("/*", i)) i = src.indexOf("*/", i) + 2;
    else out += src[i++];
  }
  return out;
}
/** Splits on top-level commas (parens, angle brackets, braces and string literals nest). */
function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if ("(<{".includes(c)) depth++;
    if (")>}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}
/** Drops @Annotation(...) / @Annotation, returning the remaining text plus the raw annotation text of the COMPONENT itself
 *  (annotations nested in a type argument, `List<@NotNull UUID>`, constrain the elements, not the component: dropped, not returned). */
function peelAnnotations(comp) {
  let rest = "";
  const annotations = [];
  let angle = 0;
  for (let i = 0; i < comp.length; ) {
    if (comp[i] === "<") angle++;
    if (comp[i] === ">") angle--;
    if (comp[i] === "@") {
      let j = i + 1;
      while (/[\w.]/.test(comp[j] ?? "")) j++;
      while (/\s/.test(comp[j] ?? "")) j++;
      if (comp[j] === "(") {
        let depth = 0;
        do {
          if (comp[j] === '"') {
            j++;
            while (comp[j] !== '"') j += comp[j] === "\\" ? 2 : 1;
          }
          if (comp[j] === "(") depth++;
          if (comp[j] === ")") depth--;
          j++;
        } while (depth > 0);
      }
      if (angle === 0) annotations.push(comp.slice(i, j));
      i = j;
    } else rest += comp[i++];
  }
  return { type: rest.trim(), annotations };
}

/**
 * Components of `record Name(...)`: [{ name, type, nullable, annotations }]. `type` is the Java type text without annotations;
 * `nullable` is true when the schema says so (@Schema nullable = true / "null" in types) or the type is boxed-optional by contract.
 */
export function recordComponents(name) {
  const src = stripComments(javaSource(name));
  const start = src.search(new RegExp(`record\\s+${name}\\s*(<[^>]*>)?\\s*\\(`));
  if (start < 0) throw new Error(`${name} is not a record`);
  let i = src.indexOf("(", start);
  const open = i;
  let depth = 0;
  do {
    if (src[i] === '"') {
      i++;
      while (src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    }
    if (src[i] === "(") depth++;
    if (src[i] === ")") depth--;
    i++;
  } while (depth > 0);
  return splitTop(src.slice(open + 1, i - 1)).map((comp) => {
    const { type, annotations } = peelAnnotations(comp);
    const m = /^([\s\S]+)\s+(\w+)$/.exec(type);
    if (!m) throw new Error(`${name}: cannot parse component "${comp.slice(0, 80)}"`);
    const ann = annotations.join(" ");
    return { name: m[2], type: m[1].replace(/\s+/g, " ").trim(), nullable: /nullable\s*=\s*true|"null"/.test(ann), annotations: ann };
  });
}
export const enumConstants = (name) => {
  const src = stripComments(javaSource(name));
  const body = /enum\s+\w+\s*\{([^;}]*)/.exec(src)?.[1] ?? "";
  return body.split(",").map((s) => s.trim()).filter(Boolean);
};

/** The integer value of `NAME = 10` / `int name = 60` in a Java type (constants and property defaults). */
export function javaInt(typeName, field) {
  const m = new RegExp(`\\b${field}\\s*=\\s*(\\d+)\\s*;`).exec(stripComments(javaSource(typeName)));
  if (!m) throw new Error(`${typeName}.${field} = <int> not found`);
  return Number(m[1]);
}
