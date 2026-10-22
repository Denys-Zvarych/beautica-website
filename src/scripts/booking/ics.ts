// Client-side .ics (RFC 5545) for "add to calendar": built and downloaded in the browser, nothing leaves the page.
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Lines longer than 75 octets (Cyrillic = 2 octets per char, so folded every 35 chars) are folded (CRLF + space). */
const fold = (line: string) => line.replace(/(.{35})(?=.)/g, "$1\r\n ");

export interface IcsEvent {
  uid: string;
  startsAt: string;
  minutes: number;
  summary: string;
  description: string;
  location: string;
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
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function downloadIcs(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
