// Pure date logic of the booking flow (Europe/Kyiv). Dates are "YYYY-MM-DD" strings; arithmetic runs at noon UTC so DST never
// shifts a day. No DOM here: unit-tested in tests/booking-lib.test.mjs.
import { KYIV } from "../../lib/booking/format.ts";

/** Backend window: today ... today + 60 days (GuestBookingService.availableSlots). */
export const WINDOW_DAYS = 60;

export const kyivToday = (now: Date = new Date()): string => new Intl.DateTimeFormat("en-CA", { timeZone: KYIV, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const utc = (iso: string): Date => new Date(`${iso}T12:00:00Z`);
const iso = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

export const inWindow = (day: string, today: string): boolean => day >= today && day <= addDays(today, WINDOW_DAYS);

/** Monday = 0 ... Sunday = 6. */
export const weekdayMon0 = (day: string): number => (utc(day).getUTCDay() + 6) % 7;

export interface MonthView {
  /** First day of the month, "YYYY-MM-01". */
  first: string;
  /** Empty cells before day 1 (Monday-first week). */
  lead: number;
  days: string[];
}

export function monthView(today: string, offset: number): MonthView {
  const t = utc(today);
  const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + offset, 1, 12));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12));
  const days: string[] = [];
  for (let d = 1; d <= last.getUTCDate(); d++) days.push(iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d, 12))));
  return { first: iso(first), lead: weekdayMon0(iso(first)), days };
}

/** How many months ahead of today's month hold at least one bookable day. */
export function maxMonthOffset(today: string): number {
  const a = utc(today);
  const b = utc(addDays(today, WINDOW_DAYS));
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const monthLabel = (day: string): string => `${cap(new Intl.DateTimeFormat("uk-UA", { month: "long", timeZone: "UTC" }).format(utc(day)))} ${utc(day).getUTCFullYear()}`;
export const weekdayShort = (mon0: number): string => new Intl.DateTimeFormat("uk-UA", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + mon0, 12)));
export const dayLong = (day: string): string => new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(utc(day));
export const dayShort = (day: string): string => new Intl.DateTimeFormat("uk-UA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(utc(day));
export const kyivTime = (isoDateTime: string): string => new Intl.DateTimeFormat("uk-UA", { timeZone: KYIV, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(isoDateTime));
/** Kyiv calendar day of an instant. */
export const kyivDay = (isoDateTime: string): string => kyivToday(new Date(isoDateTime));
export const daysBetween = (from: string, to: string): number => Math.round((utc(to).getTime() - utc(from).getTime()) / 86400000);

export type Part = "morning" | "day" | "evening";
/** Ranges as the app's slot picker groups them. */
export function partOfDay(time: string): Part {
  const h = Number(time.slice(0, 2));
  return h < 12 ? "morning" : h < 17 ? "day" : "evening";
}
