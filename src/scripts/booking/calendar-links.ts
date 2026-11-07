// «Додати в календар»: the three ways to put a booking in a calendar. Pure, no DOM. Content = time, master, services, place and the cancel link (the guest already gets it by SMS), never a phone or name.
// Google is a top-level navigation (target=_blank) to Google Calendar's own "new event" page: it works in every in-app webview (Telegram, Instagram,
// Facebook) and on Android, where a downloaded .ics has no handler. The .ics link (/api/ics, served inline) is for iPhone / iPad / macOS.
import { cancelPath, cancelToken } from "./api.ts";
import { isIosInAppBrowser, type OtpEnv } from "./otp-format.ts";

export interface CalendarEvent {
  /** UTC ISO instant. */
  startsAt: string;
  minutes: number;
  title: string;
  description: string;
  location: string;
  /** Absolute cancel URL on the page's own origin + the line label; absent or not a valid cancel path = no link anywhere. */
  cancel?: { url: string; label: string };
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

/** A bare UA string (no touch / Telegram-proxy info) or the full detection env shared with the OTP code (src/scripts/booking/otp-format.ts). */
export type CalEnv = OtpEnv | string;
const toEnv = (e: CalEnv): OtpEnv => (typeof e === "string" ? { ua: e, maxTouchPoints: 0, hasTelegramProxy: false } : e);

/** iOS in-app browsers (Instagram, Facebook, Telegram, WhatsApp, ...) run their own WKWebView that never hands a text/calendar response to the system «Add event» sheet:
 *  `x-safari-https://` (iOS 17+) opens Safari, which does. Everything else keeps the plain relative link. Detection lives in otp-format.ts only. */
export const isIosInApp = (e: CalEnv): boolean => isIosInAppBrowser(toEnv(e));
export const appleHref = (path: string, origin: string, e: CalEnv): string => (isIosInApp(e) && /^https?:\/\//.test(origin) ? `x-safari-${origin}${path}` : path);

export function calendarLinks(ev: CalendarEvent, env: CalEnv = "", origin = ""): Record<CalendarKind, string> {
  const e = toEnv(env);
  const start = new Date(ev.startsAt);
  const end = new Date(start.getTime() + ev.minutes * 60000);
  const title = cap(ev.title, 120);
  const path = ev.cancel ? cancelPath(ev.cancel.url) : null;
  const token = cancelToken(path);
  // The cancel line is never the part that is cut: the services text gives way first.
  const line = token && ev.cancel ? `${ev.cancel.label}: ${ev.cancel.url}` : "";
  const details = line ? `${cap(ev.description, Math.max(0, 500 - line.length - 1))}\n${line}` : cap(ev.description, 500);
  const where = cap(ev.location, 200);
  const ics = new URLSearchParams({ s: utc(start), e: utc(end), t: title, d: cap(ev.description, 500) }); // the .ics endpoint adds the cancel line itself
  if (where) ics.set("l", where);
  if (token) ics.set("c", token);
  const g = new URLSearchParams({ action: "TEMPLATE", text: title, ctz: "Europe/Kyiv", dates: `${utc(start).replace(/[-:]/g, "")}/${utc(end).replace(/[-:]/g, "")}`, details });
  if (where) g.set("location", where);
  return {
    google: googleHref(`https://calendar.google.com/calendar/render?${g}`, e.ua),
    apple: appleHref(`/api/ics?${ics}`, origin, e),
  };
}

/** Apple devices (iPhone, iPad, macOS) get the .ics first; everywhere else Google first. Both are always reachable. */
export const calendarOrder = (ua: string): CalendarKind[] => (/(iPhone|iPad|iPod|Macintosh)/.test(ua) ? ["apple", "google"] : ["google", "apple"]);
