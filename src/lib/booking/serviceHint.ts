// Copy hint for services that share one displayed name (website phase 036). One rule with the app (mobile `service_name_hint.dart`,
// phase 469); the shared fixture cases live in tests/service-hint.test.mjs. `name` is the displayed name; the public API sends no
// separate custom name today, so `customName` stays optional and the hint is the duration.
import { formatDuration } from "./duration.ts";

export interface ServiceHintInput {
  id: string;
  name: string;
  customName?: string | null;
  durationMinutes: number;
}

const norm = (v: string): string => v.trim().toLowerCase();

/** Hints keyed by service id, for ONE owner's list (across categories). A group of one gets no entry. */
export function serviceNameHints(items: readonly ServiceHintInput[]): Map<string, string> {
  const groups = new Map<string, ServiceHintInput[]>();
  for (const it of items) {
    const k = norm(it.name);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const hints = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const it of g) {
      const custom = (it.customName ?? "").trim();
      hints.set(it.id, custom && norm(custom) !== norm(it.name) ? custom : formatDuration(it.durationMinutes));
    }
  }
  return hints;
}
