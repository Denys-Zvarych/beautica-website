// W052 D5: what the sidebar shows next to «Заявки»: the pending count (amber when any request has waited 3+ days). A failure hides the count and never fails the page.
import type { AdminConfig } from "./config.ts";
import { listPending, type CatalogRequest } from "./requests.ts";
import { anyUrgent } from "./requestAge.ts";

export interface NavInfo { count: number | null; urgent: boolean }
export const NAV_UNKNOWN: NavInfo = { count: null, urgent: false };

/** From a pending list the page already loaded (no second backend call). */
export const navFrom = (items: CatalogRequest[], total = items.length, now: Date = new Date()): NavInfo => ({ count: total, urgent: anyUrgent(items.map((r) => r.createdAt), now) });

/** ONE backend call (page 1 of the pending list: `total` = the count; the amber flag reads page 1, which the backend returns oldest first, so it holds the longest-waiting requests;
 * if the backend order ever changed, the flag could miss an old request on page 2+, the count stays exact). Used when the page did not load the list itself. */
export async function loadNav(cfg: AdminConfig, actor: string): Promise<NavInfo> {
  try {
    const all = await listPending(cfg, actor, 1);
    return all.ok ? navFrom(all.items, all.total) : NAV_UNKNOWN;
  } catch {
    return NAV_UNKNOWN;
  }
}
