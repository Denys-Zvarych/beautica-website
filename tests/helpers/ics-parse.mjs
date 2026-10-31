// A strict, dependency-free RFC 5545 reader for the .ics the booking flow generates (phase 015 QA).
// It throws on anything a calendar app could mis-read: bare CR/LF, over-long physical lines, bad folding, unknown property names,
// unbalanced components, unescaped TEXT specials, duplicate/missing required properties, and, since phase 025, ANY URL property (the file never carries a cancel link).
const TEXT_PROPS = new Set(["SUMMARY", "DESCRIPTION", "LOCATION"]);
const ALLOWED = {
  VCALENDAR: new Set(["VERSION", "PRODID", "CALSCALE"]),
  VEVENT: new Set(["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "DESCRIPTION", "LOCATION"]),
};
const REQUIRED = { VCALENDAR: ["VERSION", "PRODID"], VEVENT: ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "DESCRIPTION"] };
const fail = (m) => { throw new Error(`invalid iCalendar: ${m}`); };

/** @returns {{ VCALENDAR: Record<string,string>, VEVENT: Record<string,string>, text: Record<string,string> }} raw values + decoded TEXT values */
export function parseIcs(ics) {
  if (!ics.endsWith("\r\n")) fail("must end with CRLF");
  const physical = ics.slice(0, -2).split("\r\n");
  for (const l of physical) {
    if (/[\r\n]/.test(l)) fail(`bare CR/LF in: ${JSON.stringify(l)}`);
    if (Buffer.byteLength(l) > 75) fail(`line over 75 octets (${Buffer.byteLength(l)}): ${l}`);
    if (l === "") fail("empty line");
  }
  const lines = [];
  for (const l of physical) {
    if (l.startsWith(" ")) {
      if (!lines.length) fail("continuation before any line");
      lines[lines.length - 1] += l.slice(1);
    } else if (l.startsWith("\t")) fail("tab-led line");
    else lines.push(l);
  }
  const stack = [];
  const seen = { VCALENDAR: {}, VEVENT: {} };
  const text = {};
  let events = 0;
  if (lines[0] !== "BEGIN:VCALENDAR") fail("first line must be BEGIN:VCALENDAR");
  if (lines.at(-1) !== "END:VCALENDAR") fail("last line must be END:VCALENDAR");
  for (const l of lines) {
    if (/[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/.test(l)) fail(`control char in: ${JSON.stringify(l)}`);
    const m = /^([A-Z][A-Z0-9-]*)(;[A-Z-]+=[^:;,"]+)*:(.*)$/.exec(l);
    if (!m) fail(`not a content line: ${l}`);
    const [, name, , value] = m;
    if (name === "BEGIN") {
      if (value === "VEVENT" && stack.at(-1) !== "VCALENDAR") fail("VEVENT outside VCALENDAR");
      if (value === "VCALENDAR" && stack.length) fail("nested VCALENDAR");
      if (!(value in ALLOWED)) fail(`unknown component ${value}`);
      if (value === "VEVENT") events++;
      stack.push(value);
    } else if (name === "END") {
      if (stack.pop() !== value) fail(`END:${value} does not close the open component`);
    } else {
      const comp = stack.at(-1);
      if (!comp || !ALLOWED[comp].has(name)) fail(`property ${name} not allowed in ${comp}`);
      if (name in seen[comp]) fail(`duplicate ${name}`);
      seen[comp][name] = value;
      if (TEXT_PROPS.has(name)) {
        if (/(^|[^\\])(\\\\)*[;,]/.test(value)) fail(`unescaped ; or , in ${name}: ${value}`);
        if (/\\[^\\;,nN]/.test(value.replace(/\\\\/g, ""))) fail(`bad escape in ${name}: ${value}`);
        text[name] = value.replace(/\\(.)/g, (_, c) => (c === "n" || c === "N" ? "\n" : c)); // single pass: \\ \; \, \n
      }
    }
  }
  if (stack.length) fail("unclosed component");
  if (events !== 1) fail(`expected exactly one VEVENT, got ${events}`);
  for (const [c, req] of Object.entries(REQUIRED)) for (const p of req) if (!(p in seen[c])) fail(`${c} lacks ${p}`);
  if (seen.VCALENDAR.VERSION !== "2.0") fail("VERSION must be 2.0");
  for (const p of ["DTSTAMP", "DTSTART", "DTEND"]) if (!/^\d{8}T\d{6}Z$/.test(seen.VEVENT[p])) fail(`${p} is not a UTC date-time: ${seen.VEVENT[p]}`);
  if (seen.VEVENT.DTEND <= seen.VEVENT.DTSTART) fail("DTEND must be after DTSTART");
  return { ...seen, text };
}
