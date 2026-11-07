// GET /api/ics?s=<start UTC>&e=<end UTC>&t=<summary>&l=<location>&d=<description>: the «Додати в календар» file (phase 025).
// iOS Safari shows «Add event» only for a text/calendar file from a real https URL, so the browser navigates here; served `inline` (iOS 13+ sends attachments to Downloads).
// The query carries what the guest already sees (time, master, services, place) plus `c` = the cancel TOKEN only (never a URL: the link is built here from this
// request's own origin, so a crafted link cannot put a foreign URL into a calendar file). Never a phone or name. Nothing is stored; our code logs nothing; Cloudflare invocation logs (they hold the URL) are off in wrangler.jsonc.
import type { APIRoute } from "astro";
import { cancelPathFromToken } from "../../scripts/booking/api.ts";
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
  // A page on another site must not make a visitor open calendar files with attacker-chosen text: Sec-Fetch-Site, plus an Origin/Referer host check for browsers without it (Safari <= 15).
  // Compared with the request's own host; absent headers (typed URL, non-browser client) stay allowed, an unparsable one counts as foreign.
  if (request.headers.get("sec-fetch-site") === "cross-site") return forbidden();
  for (const name of ["origin", "referer"]) {
    const v = request.headers.get(name);
    if (v === null) continue;
    let host: string | null = null;
    try {
      host = new URL(v).host;
    } catch {
      /* unparsable: foreign */
    }
    if (host !== url.host) return forbidden();
  }
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
  const c = q.get("c");
  const cancelPath = c === null ? null : cancelPathFromToken(c);
  if (c !== null && cancelPath === null) return bad();
  const body = buildIcs({ uid: crypto.randomUUID(), startsAt: start.toISOString(), minutes, summary, description, location, ...(cancelPath ? { cancelUrl: `${url.origin}${cancelPath}` } : {}) });
  return new Response(body, {
    status: 200,
    headers: { ...headers, "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="beautica-booking.ics"' },
  });
};

/** HEAD = GET without the body: same validation, status and headers. */
export const HEAD: APIRoute = async (ctx) => {
  const res = await (GET as (c: typeof ctx) => Response | Promise<Response>)(ctx);
  return new Response(null, { status: res.status, headers: res.headers });
};

export const ALL: APIRoute = () => new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
