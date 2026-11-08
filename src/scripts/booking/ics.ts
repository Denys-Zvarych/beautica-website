// Content = time, master, services, place and the cancel link (the guest already gets it by SMS), never a phone or a name. Nothing is stored; our code logs nothing; Cloudflare invocation logs (they hold the URL) are off in wrangler.jsonc.
// .ics (RFC 5545) builder for "add to calendar". Used by the on-demand route src/pages/api/ics.ts (phase 025); the page only links to it.
const esc = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n|\u2028|\u2029|\u0085/g, "\\n") // any line break becomes the TEXT escape, never a raw CR/LF
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x84\x86-\x9f]/g, "") // other control characters (incl. C1) are dropped (no property injection)
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Content lines longer than 75 octets are folded (CRLF + space); counted in UTF-8 octets, never splitting a code point. */
const fold = (line: string) => {
  let out = "";
  let used = 0;
  for (const ch of line) {
    const c = ch.codePointAt(0) as number;
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; // UTF-8 octets (a lone surrogate encodes as 3)
    if (used + n > 75) {
      out += "\r\n ";
      used = 1; // the continuation line starts with one space
    }
    out += ch;
    used += n;
  }
  return out;
};

/** Label of the cancel line in DESCRIPTION; pinned equal to uk.json `book.ics.cancel` (tests/book-ics.test.mjs). */
export const CANCEL_LABEL = "Скасувати запис";

export interface IcsEvent {
  uid: string;
  startsAt: string;
  minutes: number;
  summary: string;
  description: string;
  location: string;
  /** Absolute cancel URL built by the endpoint from its own origin and a validated token (never from a request value). */
  cancelUrl?: string;
}

export function buildIcs(e: IcsEvent, now: Date = new Date()): string {
  const start = new Date(e.startsAt);
  const end = new Date(start.getTime() + e.minutes * 60000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Beautica//Booking//UK",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}@beautica.app`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(e.summary)}`,
    `DESCRIPTION:${esc(e.cancelUrl ? `${e.description}\n${CANCEL_LABEL}: ${e.cancelUrl}` : e.description)}`,
    ...(e.cancelUrl ? [`URL:${e.cancelUrl}`] : []),
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    // A reminder one hour before (shown by the calendar app itself).
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(e.summary)}`,
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
