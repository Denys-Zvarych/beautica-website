// GET /api/ics?s=<start UTC>&e=<end UTC>&t=<summary>&l=<location>&d=<description>: the «Додати в календар» file (phase 025).
// iOS Safari opens its native «Add event» sheet only for a text/calendar file fetched from a real https URL (not a blob / data: URL),
// so the browser navigates here. The query carries only what the guest already sees on screen: the time, the master's name, the
// services and the place. Never a cancel link, phone or guest name (the cancel link arrives by SMS). Nothing is stored or logged.
import type { APIRoute } from "astro";
import { buildIcs } from "../../scripts/booking/ics.ts";

export const prerender = false;

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const MAX = { t: 120, l: 200, d: 500 } as const;
const MAX_MINUTES = 24 * 60;
const YEARS = { min: 2020, max: 2100 } as const;
/** C0/C1 controls and the Unicode line/paragraph separators. */
const CONTROLS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");
/** `2026-11-08T12:00:00Z` (UTC, optional milliseconds): the only accepted time shape. */
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const bad = (): Response => new Response("Bad request", { status: 400, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });

const forbidden = (): Response => new Response("Forbidden", { status: 403, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });

/** Single line, no control characters, trimmed; over `max` characters it is cut and ends with «…» (a long real booking still works).
 *  null = missing or empty when required. */
function text(raw: string | null, max: number, required: boolean): string | null {
  if (raw === null) return required ? null : "";
  const clean = raw.replace(CONTROLS, " ").trim();
  if (required && !clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}…` : clean;
}

export const GET: APIRoute = ({ url, request }) => {
  // A page on another site must not be able to make a visitor's browser fetch calendar files from us (abuse); same-origin, typed URL and non-browser clients stay allowed.
  if (request.headers.get("sec-fetch-site") === "cross-site") return forbidden();
  const q = url.searchParams;
  const s = q.get("s") ?? "";
  const e = q.get("e") ?? "";
  if (!UTC.test(s) || !UTC.test(e)) return bad();
  const start = new Date(s);
  const minutes = (new Date(e).getTime() - start.getTime()) / 60000;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) return bad();
  const year = start.getUTCFullYear();
  if (year < YEARS.min || year > YEARS.max) return bad();
  const summary = text(q.get("t"), MAX.t, true);
  const location = text(q.get("l"), MAX.l, false);
  const description = text(q.get("d"), MAX.d, false);
  if (summary === null || location === null || description === null) return bad();
  const body = buildIcs({ uid: crypto.randomUUID(), startsAt: start.toISOString(), minutes, summary, description, location });
  return new Response(body, {
    status: 200,
    headers: { ...headers, "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="beautica-booking.ics"' },
  });
};

/** HEAD = GET without the body: same validation, status and headers. */
export const HEAD: APIRoute = async (ctx) => {
  const res = await (GET as (c: typeof ctx) => Response | Promise<Response>)(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
