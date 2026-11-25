// W052 (WEB-70): how long a pending request has waited. Requests never expire; only the approve / reject links in the notification e-mail do
// (backend TTL P7D), so the e-mail-link wording is switched by ONE constant. Owner decision 2026-11-25: request e-mails become notification-only (B545), so it is null. Pure: copy is returned as an i18n key
// (+ vars) and rendered by the component with t(), so this module stays importable by plain Node tests.
/** Days the links in the notification e-mail stay valid; null = no links any more (the badge then says only «Чекає N дн.»). */
export const REQUEST_EMAIL_LINK_DAYS: number | null = null;
export const AGE_WARN_DAYS = 3;
export const AGE_BAD_DAYS = 7;
export type AgeBand = "ok" | "warn" | "bad";

const KYIV_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }); // one per isolate
const dayNumber = (d: Date): number => {
  const [y, m, day] = KYIV_DAY.format(d).split("-").map(Number);
  return Date.UTC(y, m - 1, day) / 86_400_000;
};

/** Whole calendar days in Europe/Kyiv between `createdAt` and `now` (the server clock); never negative, 0 for an unreadable date. */
export function ageDays(createdAt: string, now: Date = new Date()): number {
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? 0 : Math.max(0, dayNumber(now) - dayNumber(d));
}
export const ageBand = (days: number): AgeBand => (days >= AGE_BAD_DAYS ? "bad" : days >= AGE_WARN_DAYS ? "warn" : "ok");

export interface Msg { key: string; vars?: Record<string, number> }
/** «Чекає від сьогодні» / «Чекає N дн.». */
export const ageLabelMsg = (days: number): Msg => (days > 0 ? { key: "admin.age.waits", vars: { n: days } } : { key: "admin.age.today" });

/** Tooltip + hidden text about the e-mail link; only from the warning band on, and only while the links exist (`linkDays` non-null). */
export function linkTipMsg(days: number, linkDays: number | null = REQUEST_EMAIL_LINK_DAYS): Msg | null {
  if (linkDays === null || days < AGE_WARN_DAYS) return null;
  return days >= linkDays ? { key: "admin.age.linkGone" } : { key: "admin.age.linkLeft", vars: { n: linkDays - days } };
}
export const anyUrgent = (createdAts: string[], now: Date = new Date()): boolean => createdAts.some((c) => ageDays(c, now) >= AGE_WARN_DAYS);
