// Calendar event text for a guest booking (phase 038, GST-78): title «{first} · {master}» / «{first} +{n} · {master}», one description line per service
// «{HH:mm} {name} · {duration}» (no price). Pure, no DOM; shared by the done screens and /c/{token}?n=1. Times are Europe/Kyiv.
import { KYIV, formatDuration } from "../../lib/booking/duration.ts?ics";

export interface IcsService {
  name: string;
  minutes: number;
  /** UTC ISO start; absent = chained from the previous service's end (done flows: from the chosen slot). */
  startsAt?: string;
}

export interface IcsLineStrings {
  /** «{first} · {master}» */
  summary: string;
  /** «{first} +{n} · {master}» */
  summaryMore: string;
  /** «{time} {name} · {duration}» */
  line: string;
}

const fmt = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
const hhmm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: KYIV, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

export function icsSummary(items: IcsService[], master: string, S: Pick<IcsLineStrings, "summary" | "summaryMore">): string {
  const first = items[0]?.name ?? "";
  return items.length > 1 ? fmt(S.summaryMore, { first, n: items.length - 1, master }) : fmt(S.summary, { first, master });
}

/** One line per service, in order. Each item starts at its own `startsAt`, else where the previous one ended (the first at `startsAt`). */
export function icsServiceLines(items: IcsService[], startsAt: string, S: Pick<IcsLineStrings, "line">): string[] {
  let at = new Date(startsAt).getTime();
  return items.map((it) => {
    if (it.startsAt) at = new Date(it.startsAt).getTime();
    const out = fmt(S.line, { time: hhmm(at), name: it.name, duration: formatDuration(it.minutes) });
    at += it.minutes * 60000;
    return out;
  });
}

/** Description cap shared by GET /api/ics and the Google link. Bound: backend allows 10 services per visit (MAX_SERVICES_PER_VISIT), name <= 100:
 *  10 x ("HH:mm " 6 + 100 + " · 12 год 30 хв" 15) + 9 newlines = 1219, + cancel line (label + url, ~70) = ~1290; 1500 leaves headroom.
 *  Worst case the percent-encoded Google/Apple URL is ~9 KB (Cyrillic = 6 chars per letter), under the 16 KB request-line limit. */
export const DESCRIPTION_MAX = 1500;
