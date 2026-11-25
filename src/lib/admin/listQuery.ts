// W052 (WEB-69): the GET params of the /admin lists, parsed and applied in the Worker over the data it already loaded (the backend has no search).
// `kind` / `f` / `q` / `p` from the URL are untrusted: an unknown filter falls back to the default, `q` is trimmed and capped. Pure.
import type { Category } from "./catalog.ts";
import type { CatalogRequest } from "./requests.ts";

export const REQUEST_KINDS = ["ALL", "CATEGORY", "SERVICE_TYPE"] as const;
export type RequestKindFilter = (typeof REQUEST_KINDS)[number];
export const CATALOG_FILTERS = ["ALL", "LIVE", "HIDDEN", "PENDING", "UNUSED"] as const;
export type CatalogFilter = (typeof CATALOG_FILTERS)[number];
export const Q_MAX = 100; // code points

export const parseKindFilter = (raw: unknown): RequestKindFilter => ((REQUEST_KINDS as readonly string[]).includes(raw as string) ? (raw as RequestKindFilter) : "ALL");
export const parseCatalogFilter = (raw: unknown): CatalogFilter => ((CATALOG_FILTERS as readonly string[]).includes(raw as string) ? (raw as CatalogFilter) : "ALL");
/** Search text: trimmed, at most 100 code points (the cut is by code point, never mid-surrogate). */
export const parseQuery = (raw: unknown): string => (typeof raw === "string" ? [...raw.trim()].slice(0, Q_MAX).join("").trim() : "");

const fold = (s: string): string => s.toLocaleLowerCase("uk");
/** Case-insensitive substring over the joined haystack parts. */
export const matchesQuery = (parts: (string | null | undefined)[], q: string): boolean => q === "" || fold(parts.filter(Boolean).join(" ")).includes(fold(q));

/** The name a request is listed under: a category's display name, a type's name. */
export const requestLabel = (r: CatalogRequest): string => (r.kind === "CATEGORY" ? r.displayName || r.name : r.name);

export const filterRequests = (items: CatalogRequest[], kind: RequestKindFilter, q: string): CatalogRequest[] =>
  items.filter((r) => (kind === "ALL" || r.kind === kind) && matchesQuery([requestLabel(r), r.categoryName, r.requesterLabel], q));

/** LIVE = approved and active; HIDDEN = approved and not active; PENDING; UNUSED = approved, no usage, no types. REJECTED shows only under ALL. */
export const catalogMatches = (c: Category, f: CatalogFilter): boolean => {
  switch (f) {
    case "ALL": return true;
    case "LIVE": return c.status === "APPROVED" && c.active;
    case "HIDDEN": return c.status === "APPROVED" && !c.active;
    case "PENDING": return c.status === "PENDING";
    case "UNUSED": return c.status === "APPROVED" && c.usageCount === 0 && c.typeCount === 0;
  }
};
export const filterCatalog = (cats: Category[], f: CatalogFilter, q: string): Category[] => cats.filter((c) => catalogMatches(c, f) && matchesQuery([c.displayName, c.name], q));

export interface PageSlice<T> { slice: T[]; page: number; pages: number; total: number; from: number; to: number }
/** `page` is clamped into 1..pages; from/to are 1-based display numbers (0/0 when empty). */
export function paginate<T>(items: T[], page: number, size: number): PageSlice<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page), pages);
  const slice = items.slice((p - 1) * size, p * size);
  return { slice, page: p, pages, total: items.length, from: slice.length ? (p - 1) * size + 1 : 0, to: slice.length ? (p - 1) * size + slice.length : 0 };
}

/** `base?a=1&b=2`, skipping empty / undefined params (a default filter never shows up in the URL). */
export function withQuery(base: string, params: Record<string, string | number | null | undefined | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && String(v) !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `${base}?${s}` : base;
}

/** Ukrainian plural form: [one, few, many] for 1 / 2-4 / 0, 5-20. */
export function pluralUk(n: number, forms: readonly [string, string, string]): string {
  const m100 = n % 100, m10 = n % 10;
  return m100 >= 11 && m100 <= 14 ? forms[2] : m10 === 1 ? forms[0] : m10 >= 2 && m10 <= 4 ? forms[1] : forms[2];
}
