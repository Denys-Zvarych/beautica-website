// «Додати в календар»: the three ways to put a booking in a calendar. Pure, no DOM. Content = time, master, services, place only (never a cancel link, phone or name).
// Google is a top-level navigation (target=_blank) to Google Calendar's own "new event" page: it works in every in-app webview (Telegram, Instagram,
// Facebook) and on Android, where a downloaded .ics has no handler. The .ics link (/api/ics, served inline) is for iPhone / iPad / macOS.
export interface CalendarEvent {
  /** UTC ISO instant. */
  startsAt: string;
  minutes: number;
  title: string;
  description: string;
  location: string;
}

export type CalendarKind = "google" | "apple";

/** Same limits as GET /api/ics (t 120, l 200, d 500), cut with «…». */
export const cap = (v: string, max: number): string => (v.length > max ? `${v.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…` : v);

const utc = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Android only: an intent:// link opens the Google Calendar app straight from in-app webviews (Instagram, Facebook, Telegram); the https template is the fallback
 *  (browser_fallback_url, encoded once more). Every other platform keeps the plain https link. */
export const googleHref = (https: string, ua: string): string => {
  if (!/Android/.test(ua)) return https;
  const u = new URL(https);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.google.android.calendar;S.browser_fallback_url=${encodeURIComponent(https)};end`;
};

export function calendarLinks(ev: CalendarEvent, ua = ""): Record<CalendarKind, string> {
  const start = new Date(ev.startsAt);
  const end = new Date(start.getTime() + ev.minutes * 60000);
  const title = cap(ev.title, 120);
  const details = cap(ev.description, 500);
  const where = cap(ev.location, 200);
  const ics = new URLSearchParams({ s: utc(start), e: utc(end), t: title, d: details });
  if (where) ics.set("l", where);
  const g = new URLSearchParams({ action: "TEMPLATE", text: title, ctz: "Europe/Kyiv", dates: `${utc(start).replace(/[-:]/g, "")}/${utc(end).replace(/[-:]/g, "")}`, details });
  if (where) g.set("location", where);
  return {
    google: googleHref(`https://calendar.google.com/calendar/render?${g}`, ua),
    apple: `/api/ics?${ics}`,
  };
}

/** Apple devices (iPhone, iPad, macOS) get the .ics first; everywhere else Google first. Both are always reachable. */
export const calendarOrder = (ua: string): CalendarKind[] => (/(iPhone|iPad|iPod|Macintosh)/.test(ua) ? ["apple", "google"] : ["google", "apple"]);
