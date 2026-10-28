// Client-side .ics (RFC 5545) for "add to calendar": built and downloaded in the browser, nothing leaves the page.
const esc = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n|\u2028|\u2029|\u0085/g, "\\n") // any line break becomes the TEXT escape, never a raw CR/LF
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x84\x86-\x9f]/g, "") // other control characters (incl. C1) are dropped (no property injection)
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
/** The URL property is a raw URI: only a single-line http(s) URL without whitespace/controls is emitted (location.origin is http://localhost:… in local dev). */
const SAFE_URL = /^https?:\/\/[^\s\x00-\x1f\x7f-\x9f]+$/;
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

export interface IcsEvent {
  uid: string;
  startsAt: string;
  minutes: number;
  summary: string;
  description: string;
  location: string;
  /** Optional RFC 5545 URL property (the guest's cancel link). Omitted: the file is byte-identical to before. */
  url?: string;
}

export function buildIcs(e: IcsEvent, now: Date = new Date()): string {
  const start = new Date(e.startsAt);
  const end = new Date(start.getTime() + e.minutes * 60000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Beautica//Booking//UK",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${e.uid}@beautica.app`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(e.summary)}`,
    `DESCRIPTION:${esc(e.description)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.url && SAFE_URL.test(e.url) ? [`URL:${e.url}`] : []), // URI value type: not TEXT-escaped
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** iPhone / iPad (iPadOS reports "Macintosh" with touch). iOS Safari ignores `<a download>` on blob URLs, so it needs its own route. */
export const isIos = (): boolean => /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

const MIME = "text/calendar;charset=utf-8";

function blobDownload(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: MIME }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Hands the .ics to the device. Client-side only (the text carries the cancel-link bearer token: never sent, logged or tracked).
 * iOS: the share sheet with the file (offers "Add to Calendar"), else a `data:text/calendar` navigation, which iOS opens in the
 * system Calendar "Add event" sheet. Everything else keeps the blob download. Must be called from the click handler (user activation).
 */
export function downloadIcs(text: string, filename: string): void {
  if (!isIos()) return blobDownload(text, filename);
  const dataNav = (): void => {
    location.assign(`data:text/calendar;charset=utf-8,${encodeURIComponent(text)}`); // assign (not replace): adds a history entry, so Back returns to the confirmation
  };
  try {
    const file = new File([text], filename, { type: "text/calendar" });
    if (typeof navigator.canShare === "function" && typeof navigator.share === "function" && navigator.canShare({ files: [file] })) {
      void navigator.share({ files: [file] }).catch((err: unknown) => {
        if ((err as { name?: string } | null)?.name !== "AbortError") dataNav(); // a dismissed sheet is not a failure
      });
      return;
    }
  } catch {
    /* File / share unavailable: fall through */
  }
  dataNav();
}
