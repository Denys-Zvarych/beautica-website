// What the salon wizard and the services-tab filter need and the salon page does not carry (phases 016/017): the salon info with its
// service coverage (GET /book/s/{slug}/info, backend 391) and the wizard's steps (the static fragment /book-steps/salon). Each is fetched
// once, on the visitor's first sign of intent, and shared by whoever asks next.
import { parseSalonInfo, type SalonInfo } from "../../lib/booking/types";

let info: Promise<SalonInfo | null> | undefined;
let steps: Promise<string | null> | undefined;

/** The salon info incl. `serviceCoverage`; null on any failure (the wizard shows its error, the filter stays off). */
export function loadSalonInfo(api: string, slug: string): Promise<SalonInfo | null> {
  info ??= (async () => {
    try {
      const res = await fetch(`${api}/api/v1/book/s/${encodeURIComponent(slug)}/info`, { credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      return res.ok ? parseSalonInfo(slug, await res.json()) : null;
    } catch {
      return null;
    }
  })();
  // A failure is not remembered: the next tap tries again.
  void info.then((v) => v ?? (info = undefined));
  return info;
}

/** The templates the wizard clones; a fragment without them is from another deploy (stale cache) and unusable. */
const complete = (html: string | null): html is string => !!html && ["tpl-cat", "tpl-svc", "tpl-strip", "tpl-appt", "tpl-done"].every((id) => html.includes(`id="${id}"`));
const get = (cache: RequestCache) => fetch("/book-steps/salon", { credentials: "omit", cache }).then((r) => (r.ok ? r.text() : null)).catch(() => null);

/** The wizard's HTML (same origin, static asset, revalidated on every load). A stale copy is fetched once more bypassing the cache. */
export function loadSteps(): Promise<string | null> {
  steps ??= get("default").then(async (html) => (complete(html) ? html : ((html = await get("reload")), complete(html) ? html : null)));
  void steps.then((v) => v ?? (steps = undefined));
  return steps;
}

export function prefetch(api: string, slug: string): void {
  void loadSalonInfo(api, slug);
  void loadSteps();
}
