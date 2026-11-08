// «Додати в календар» chooser, shared by the booking done card, the salon done card and the /c/{token}?n=1 confirmed view (phase 032; moved out of app.ts).
// Google opens its "new event" page (any browser, incl. in-app webviews such as Telegram), the Apple link (GET /api/ics, served `inline`) is for iPhone / macOS.
// Inside an iOS in-app browser the Apple link is an x-safari-https link followed by script. Instagram / Facebook block that scheme: there the Apple button is left out
// and a static line says to open the page in Safari (the done URL /c/{token}?n=1 then shows the Apple button). Content: time, master, services, place and the cancel link, never a phone or name.
import { brandMarks } from "../../lib/icons/brandMarks";
import { calendarLinks, calendarOrder, isIosInApp, isIosMetaInApp } from "./calendar-links";
import { currentEnv } from "./otp-format";
import { el } from "./recap-row";

export interface CalendarStrings {
  calendar: string;
  calendarGoogle: string;
  calendarApple: string;
  /** Static line under the buttons in a non-Meta iOS in-app browser (Telegram, ...). */
  calendarIabHint: string;
  /** Static line for Instagram / Facebook on iOS. */
  calendarMetaHint: string;
  /** Event title / description templates with {master} / {services}, and the cancel line label. */
  icsSummary: string;
  icsDescription: string;
  icsCancel: string;
}

export interface CalendarBooking {
  startsAt: string;
  minutes: number;
  master: string;
  services: string;
  /** Event location text (salon, city, address); "" = none. */
  location: string;
  cancelPath?: string | null;
}

const fmt = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");

export function buildCalendarButton(S: CalendarStrings, b: CalendarBooking): HTMLElement {
  const wrap = el("div", "calwrap");
  wrap.append(el("p", "t-label", S.calendar));
  const env = currentEnv();
  const links = calendarLinks({
    startsAt: b.startsAt,
    minutes: b.minutes,
    title: fmt(S.icsSummary, { master: b.master }),
    description: fmt(S.icsDescription, { services: b.services }),
    location: b.location,
    ...(b.cancelPath ? { cancel: { url: `${location.origin}${b.cancelPath}`, label: S.icsCancel } } : {}),
  }, env, location.origin);
  const iab = isIosInApp(env);
  const meta = isIosMetaInApp(env);
  const labels = { google: S.calendarGoogle, apple: S.calendarApple } as const;
  for (const kind of calendarOrder(env.ua)) {
    if (kind === "apple" && meta) continue; // Instagram / Facebook on iOS: their WKWebView blocks the x-safari hand-off, so no button that cannot work (static line below)
    const btn = el("a", "calbtn");
    btn.href = links[kind];
    btn.dataset.cal = kind;
    btn.rel = "noopener noreferrer";
    if (kind !== "apple") btn.target = "_blank"; // Apple: top-level navigation (also the x-safari-https:// case)
    btn.innerHTML = `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${brandMarks[kind === "google" ? "google-calendar" : "apple-calendar"]}</svg><span class="t-strong115"></span>`;
    btn.querySelector("span")!.textContent = labels[kind];
    // Other iOS in-app browsers (Telegram, ...): follow the x-safari-https link by a same-tab navigation inside the tap gesture. Safari / non-iOS keep the plain anchor.
    if (kind === "apple" && iab) {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        window.location.href = links.apple;
      });
    }
    wrap.append(btn);
  }
  const hint = calendarHint(S);
  if (hint) wrap.append(hint);
  return wrap;
}

/** The static line under the buttons inside an iOS in-app browser (Meta: open-in-Safari line; others: «Не відкрилось?»), null elsewhere. The environment check is synchronous, so the /c/ page
 *  puts this same line into its reserved placeholder before first paint and the real block is exactly as tall (no shift). */
export function calendarHint(S: Pick<CalendarStrings, "calendarIabHint" | "calendarMetaHint">): HTMLElement | null {
  const env = currentEnv();
  if (!isIosInApp(env)) return null;
  const meta = isIosMetaInApp(env);
  const hint = el("p", "t-body11 calhint", meta ? S.calendarMetaHint : S.calendarIabHint);
  if (meta) hint.dataset.calHint = "meta";
  return hint;
}

const CAL_KEYS = ["calCalendar", "calGoogle", "calApple", "calIab", "calMeta", "calSummary", "calDescription", "calCancel"] as const;

/** /c/{token}?n=1 (phase 032): the chooser for one visit, strings from the page's `data-cal-*` attributes. start = first service, end = end of the last one. A missing string is a
 *  build error, never an empty label: the block is skipped (null) and the gap is logged. Lives here (not in the cancel page's script) so other /c/ visits never load it. */
export function buildVisitCalendar(d: DOMStringMap, items: { startsAt: string; durationMinutes: number; serviceName: string }[], master: string, where: string, path: string): HTMLElement | null {
  const missing = CAL_KEYS.filter((k) => !d[k]);
  const first = items[0];
  const last = items[items.length - 1];
  if (missing.length || !first || !last) {
    if (missing.length) console.warn(`calendar block skipped, missing data-${missing.join(", ")}`);
    return null;
  }
  const minutes = Math.round((new Date(last.startsAt).getTime() + last.durationMinutes * 60000 - new Date(first.startsAt).getTime()) / 60000);
  return buildCalendarButton(
    { calendar: d.calCalendar!, calendarGoogle: d.calGoogle!, calendarApple: d.calApple!, calendarIabHint: d.calIab!, calendarMetaHint: d.calMeta!, icsSummary: d.calSummary!, icsDescription: d.calDescription!, icsCancel: d.calCancel! },
    { startsAt: first.startsAt, minutes, master, services: items.map((i) => i.serviceName).join(", "), location: where, cancelPath: path },
  );
}
