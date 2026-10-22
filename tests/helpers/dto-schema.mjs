// A tiny JSON-shape model of the backend's Java records (read from source by helpers/backend.mjs): validates a JSON value against
// a DTO and resolves "services[].priceFrom"-style paths, so the mock backend and the site's parsers are checked against the real contract.
import { enumConstants, javaSource, recordComponents } from "./backend.mjs";

const STRING = new Set(["String", "UUID", "Instant", "OffsetDateTime", "ZonedDateTime", "LocalDate", "LocalDateTime"]);
const NUMBER = new Set(["int", "long", "short", "double", "Integer", "Long", "BigDecimal", "Double"]);
const BOOL = new Set(["boolean", "Boolean"]);

/** Parses a Java type text into { kind, ... }. `bind` maps generic parameters (T -> "ReviewResponse"). */
export function parseType(text, bind = {}) {
  const t = (bind[text] ?? text).trim().replace(/\b(?:[a-z]\w*\.)+(?=[A-Z])/g, ""); // java.math.BigDecimal -> BigDecimal
  let m;
  if ((m = /^List<(.+)>$/.exec(t))) return { kind: "list", elem: parseType(m[1], bind) };
  if (/^Map<|^Object$/.test(t)) return { kind: "any" };
  if (STRING.has(t)) return { kind: "string", java: t };
  if (NUMBER.has(t)) return { kind: "number" };
  if (BOOL.has(t)) return { kind: "boolean" };
  if ((m = /^(\w+)<(.+)>$/.exec(t))) return { kind: "record", name: m[1], args: [m[2]] };
  if (/^\w+$/.test(t)) {
    try {
      if (/\benum\s+\w+/.test(javaSource(t))) return { kind: "enum", name: t };
    } catch {
      throw new Error(`unmapped backend type "${t}"`);
    }
    return { kind: "record", name: t, args: [] };
  }
  throw new Error(`unmapped backend type "${t}"`);
}
/** Components of a (possibly generic) record, with its type parameters substituted. */
export function componentsOf(name, args = []) {
  const head = new RegExp(`record\\s+${name}\\s*<([^>]*)>`).exec(javaSource(name).replace(/\/\*[\s\S]*?\*\//g, ""));
  const params = head ? head[1].split(",").map((s) => s.trim()) : [];
  const bind = Object.fromEntries(params.map((p, i) => [p, args[i]]));
  return recordComponents(name).map((c) => ({ ...c, type: bind[c.type] ?? c.type.replace(new RegExp(`\\b(${params.join("|") || "$^"})\\b`, "g"), (x) => bind[x]) }));
}

/** Problems of `value` against `type` (a Java type text), each "path: message". Unknown extra keys are drift. */
export function validate(value, type, path = "$", problems = []) {
  const ty = typeof type === "string" ? parseType(type) : type;
  const bad = (msg) => problems.push(`${path}: ${msg}`);
  if (value === null) return problems; // nullability of a field is checked by the caller (it knows the component)
  switch (ty.kind) {
    case "any":
      return problems;
    case "string":
      if (typeof value !== "string") bad(`expected string (${ty.java}), got ${typeof value}`);
      else if (ty.java === "UUID" && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) bad(`not a UUID: ${value}`);
      else if (/Instant|DateTime/.test(ty.java) && Number.isNaN(Date.parse(value))) bad(`not an ISO timestamp: ${value}`);
      return problems;
    case "number":
      if (typeof value !== "number") bad(`expected number, got ${typeof value}`);
      return problems;
    case "boolean":
      if (typeof value !== "boolean") bad(`expected boolean, got ${typeof value}`);
      return problems;
    case "enum":
      if (!enumConstants(ty.name).includes(value)) bad(`${JSON.stringify(value)} is not a ${ty.name} constant`);
      return problems;
    case "list":
      if (!Array.isArray(value)) bad("expected array");
      else value.forEach((v, i) => validate(v, ty.elem, `${path}[${i}]`, problems));
      return problems;
    case "record": {
      if (typeof value !== "object" || Array.isArray(value)) return bad("expected object"), problems;
      const comps = componentsOf(ty.name, ty.args);
      const names = new Set(comps.map((c) => c.name));
      for (const k of Object.keys(value)) if (!names.has(k)) bad(`"${k}" is not a field of ${ty.name} (backend: ${[...names].join(", ")})`);
      for (const c of comps) {
        if (!(c.name in value)) continue; // the mock may omit fields the site never reads; reads are checked by pathProblems()
        if (value[c.name] === null && !c.nullable && /^[A-Z]\w*$|^List|^Map/.test(c.type) && /requiredMode\s*=\s*Schema\.RequiredMode\.REQUIRED/.test(c.annotations)) bad(`${c.name} is null but REQUIRED in ${ty.name}`);
        validate(value[c.name], parseType(c.type), `${path}.${c.name}`, problems);
      }
      return problems;
    }
  }
  return problems;
}

/** Is `path` ("services[].priceFrom", "data.guestToken") a real field chain of `type`? Returns an error string or null. */
export function pathProblem(path, type) {
  let ty = parseType(type);
  for (const seg of path.split(/\.|(?=\[\])/).filter(Boolean)) {
    if (seg === "[]") {
      if (ty.kind !== "list") return `${path}: indexed a non-list`;
      ty = ty.elem;
      continue;
    }
    if (ty.kind === "any") return null;
    if (ty.kind !== "record") return `${path}: "${seg}" read on a ${ty.kind}`;
    const c = componentsOf(ty.name, ty.args).find((x) => x.name === seg);
    if (!c) return `${path}: the site reads "${seg}" but ${ty.name} has no such field`;
    ty = parseType(c.type);
  }
  return null;
}
